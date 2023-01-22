import { ethers } from 'ethers';
import { readFile } from 'fs/promises';
import { formatReserves, formatUserSummary } from '@aave/math-utils';
import { BigNumber } from 'bignumber.js';
import fs from 'fs';

const ethPrice = 1650;

const folderLocation = '../aave-liquidator/data';
const users = []

const files = await fs.promises.readdir(folderLocation);
for(let f of files){
  const userData = JSON.parse(
    await readFile(
      `${folderLocation}/${f}`
    )
  )
  users.push(...userData);
}
console.log('files ', files);
console.log('users length ', users.length)

const unhealthyUsers = users.filter(x => x.healthFactor < 1);

const uiPoolDataProviderABI = JSON.parse(
  await readFile(
    "./uiPoolDataProviderAbi.json"
  )
);

function convertFieldsToBigNumber(item){
  for(const key in item){
    if(item[key]._isBigNumber){
      item[key] =  new BigNumber(item[key].toString());
    }
  }
  return item;
}

const provider =  new ethers.providers.WebSocketProvider('wss://polygon-mainnet.g.alchemy.com/v2/IJNymGPo47pkEyENUpN8hc1CVRosJfMv');
//const access = fs.readFileSync('/Users/brianmcclanahan/ether/eth_net_access.txt', 'utf8');
//const wallet = new ethers.Wallet(access.substring(0, access.length - 1));
//const account = wallet.connect(provider);


//const user = '0xf7b790cfca2c293ce7caff7755c10b568a1202bd';
const uiPoolDataProviderAddress = '0xC69728f11E9E6127733751c8410432913123acf1';
const poolAddressProvider = '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb'
let currentTimestamp;


const uiPoolDataProviderContract = new ethers.Contract(
  uiPoolDataProviderAddress,
  uiPoolDataProviderABI,
  provider
); 

//const reserveData = await poolContract.getReserveData(reservesList[0]);
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
} 
for(let user of unhealthyUsers){
  currentTimestamp = parseInt(Date.now() / 1000);
  console.log("timestamp ", currentTimestamp)


  let [reservesData, marketReference] = await uiPoolDataProviderContract.getReservesData(poolAddressProvider)
  reservesData = reservesData.map(
    x => {
      let item = {
        ...x
      }
      item.decimals = item.decimals.toNumber();
      return convertFieldsToBigNumber(item);
    }
  )

  const formattedReserves = formatReserves({
    reserves: reservesData,
    currentTimestamp,
    marketReferenceCurrencyDecimals : marketReference.networkBaseTokenPriceDecimals,
    marketReferencePriceInUsd: "100000000"//marketReference.networkBaseTokenPriceInUsd
  });


  let [userReserveData, userEmodeCategoryId] = await uiPoolDataProviderContract.getUserReservesData(
    poolAddressProvider, user.user_id
  );

  userReserveData = userReserveData.map(x => {
    let item = {
      ...x
    }
    return convertFieldsToBigNumber(item);
  })

  const userData = formatUserSummary({
    currentTimestamp,
    marketReferencePriceInUsd: "100000000",
    marketReferenceCurrencyDecimals: 8,
    userReserves: userReserveData,
    formattedReserves,
    userEmodeCategoryId: userEmodeCategoryId,
  });

  //console.log("formatted user data ", userSummary)

  //const userData = await poolContract.getUserAccountData(user);
  //console.log("userData ", userData);
  console.log(
    "user: ", user.user_id,
    "graph health factor: ", user.healthFactor,
    "contract health factor: ", userData.healthFactor.toString(),
    "potential profit: ", user.profit_potentialInEth * ethPrice / 10 ** 18
  );
  //console.log("user debt ", userData.totalDebtBase.toString());
  //console.log("user collateral ", userData.totalCollateralBase.toString());
  //console.log("user liquidation factor ", userData.currentLiquidationThreshold.toString());
  //const calculatedHealthFactor = userData.totalCollateralBase.mul(userData.currentLiquidationThreshold).div(userData.totalDebtBase).div(1e4);
  //console.log("calculated health factor ", calculatedHealthFactor.toString());
  console.log('waiting 2 seconds ..')
  await sleep(2000);
}