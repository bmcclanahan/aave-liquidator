import { TOKEN_LIST, APP_CHAIN_ID } from './constants';
import { ChainId, Token, TokenAmount } from '@uniswap/sdk'
import { useTradeExactIn } from './uniswap/trades';
import { gas_cost } from './utils/gas'
import { sleep } from './utils/utils'
import axios from 'axios';
import { formatReserves, formatUserSummary } from '@aave/math-utils';
import { BigNumber } from 'bignumber.js';



const GAS_USED_ESTIMATE = 1000000
const FLASH_LOAN_FEE = 0.009
const fs = require('fs');


//const theGraphURL_v2_kovan = 'https://api.thegraph.com/subgraphs/name/aave/protocol-v2-kovan'
//const theGraphURL_v2_mainnet = 'https://api.thegraph.com/subgraphs/name/aave/protocol-v2'
//const theGraphURL_v2 = APP_CHAIN_ID == ChainId.MAINNET ? theGraphURL_v2_mainnet : theGraphURL_v2_kovan
const polygonGraphURL = 'https://api.thegraph.com/subgraphs/name/ronlv10/aave-v3-polygon'
const allowedLiquidation = .5 //50% of a borrowed asset can be liquidated
const healthFactorMax = 1 //liquidation can happen when less than 1
export var profit_threshold = .1 * (10**18) //in eth. A bonus below this will be ignored

export const fetchV2UnhealthyLoans = async function fetchV2UnhealthyLoans(
  uiPoolDataProviderContract, poolAddressProvider, user_id
  ){
  var count=0;
  var maxCount=6
  var user_id_query=""

  if(user_id){
    user_id_query = `id: "${user_id}",`
    maxCount = 1
  }
  const eth_price = (await axios.get(
    'https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD'
  )).data.USD;
  console.log(`${Date().toLocaleString()} fetching unhealthy loans}`)
  while(count < maxCount){
    console.log("processing ", count)
    let res = await axios.post(polygonGraphURL, {
      query: `
      query GET_LOANS {
        users(first:1000, skip:${1000*count}, orderBy: id, orderDirection: desc, where: {${user_id_query}borrowedReservesCount_gt: 0}) {
          id
          borrowedReservesCount
          eModeCategoryId {
    			  id
    			}
          collateralReserve:reserves(where: {currentATokenBalance_gt: 0}) {
            currentATokenBalance
            reserve{
              usageAsCollateralEnabled
              reserveLiquidationThreshold
              reserveLiquidationBonus
              borrowingEnabled
              utilizationRate
              symbol
              underlyingAsset
              price {
                priceInEth
              }
              decimals
              eMode {
                id
                liquidationThreshold
              }
            }
          }
          borrowReserve: reserves(where: {currentTotalDebt_gt: 0}) {
            currentTotalDebt
            reserve{
              usageAsCollateralEnabled
              reserveLiquidationThreshold
              borrowingEnabled
              utilizationRate
              symbol
              underlyingAsset
              price {
                priceInEth
              }
              decimals
            }
          }
        }
      }`
    })
    const total_loans = res.data.data.users.length
    const result = parseUsers(res.data.data);
    const unhealthyLoans = result.unhealthyLoans;
    const all_loans = result.all_loans;
    console.log(`attempting to write ${all_loans.length} loans`);
    fs.writeFile(`data/${count}_loan_healths.json`, JSON.stringify(all_loans), (err) => {
      if (err){
        console.log(err);
      }
      else {
        console.log(`data/${count}_loan_healths.json written`);
      }
    }
    );
    console.log("loans written");
    if(unhealthyLoans.length>0) liquidationProfits(unhealthyLoans);
    if(total_loans>0) console.log(`Records:${total_loans} Unhealthy:${unhealthyLoans.length}`);
    console.log("spot check ", all_loans.find(x => x.user_id === '0xfe5fe18e658a9b63bdedfd602b8e079b4ed4eece'))
    console.log("analyzing unhealthy loans");

    await analyzeUnhealthy(
      uiPoolDataProviderContract, poolAddressProvider,
      all_loans.filter(x => x.healthFactor < 1.5), eth_price
    );
    count++;
    console.log('sleeping for 5 seconds');
    await sleep(5000);
  };
  
}

function convertFieldsToBigNumber(item){
  for(const key in item){
    if(item[key]._isBigNumber){
      item[key] =  new BigNumber(item[key].toString());
    }
  }
  return item;
}


function parseUsers(payload) {
  var loans=[];
  var all_loans=[]; 
  payload.users.forEach((user, i) => {
    var totalBorrowed=0;
    var totalCollateral=0;
    var totalCollateralThreshold=0;
    var max_borrowedSymbol;
    var max_borrowedPrincipal=0;
    var max_borrowedPriceInEth = 0;
    var max_collateralSymbol;
    var max_collateralBonus=0;
    var max_collateralPriceInEth = 0;
    var total_liquidiationThreshold = 0;
    user.borrowReserve.forEach((borrowReserve, i) => {
      //console.log('borrow reserev ', borrowReserve)
      var priceInEth= borrowReserve.reserve.price.priceInEth
      var principalBorrowed = borrowReserve.currentTotalDebt
      if (user.id == '0xfee26a46856a93b2559d29bd2d80d3cf7d1ba24e'){
        console.log('total borrowed ', priceInEth, principalBorrowed)
      }
      //console.log('borrow add ', priceInEth * principalBorrowed / (10**borrowReserve.reserve.decimals))
      totalBorrowed += priceInEth * principalBorrowed / (10**borrowReserve.reserve.decimals)
      if (principalBorrowed> max_borrowedPrincipal){
        max_borrowedSymbol = borrowReserve.reserve.symbol
        max_borrowedPrincipal = principalBorrowed
        max_borrowedPriceInEth = priceInEth
      }
    });
    user.collateralReserve.forEach((collateralReserve, i) => {
      //console.log('collateral reserev ', collateralReserve)
      var priceInEth= collateralReserve.reserve.price.priceInEth
      var principalATokenBalance = collateralReserve.currentATokenBalance
      //console.log('collateral add ', priceInEth * principalATokenBalance * (collateralReserve.reserve.reserveLiquidationThreshold/10000)/ (10**collateralReserve.reserve.decimals))
      // console.log("user id ", user.id, user.eModeCategoryId, collateralReserve.reserve.eMode,
      //   user.eModeCategoryId && collateralReserve.eMode && user.eModeCategoryId.id == collateralReserve.reserve.eMode.id
      // )

      totalCollateral += priceInEth * principalATokenBalance / (10**collateralReserve.reserve.decimals)
      if(user.eModeCategoryId && collateralReserve.reserve.eMode && user.eModeCategoryId.id == collateralReserve.reserve.eMode.id){
        totalCollateralThreshold += priceInEth * principalATokenBalance * (collateralReserve.reserve.eMode.liquidationThreshold/10000)/ (10**collateralReserve.reserve.decimals)
      }
      else {
        totalCollateralThreshold += priceInEth * principalATokenBalance * (collateralReserve.reserve.reserveLiquidationThreshold/10000)/ (10**collateralReserve.reserve.decimals)
      }
      if (collateralReserve.reserve.reserveLiquidationBonus > max_collateralBonus){
        max_collateralSymbol = collateralReserve.reserve.symbol
        max_collateralBonus=collateralReserve.reserve.reserveLiquidationBonus
        max_collateralPriceInEth = priceInEth
      }
    });
    //console.log("HF ", totalCollateralThreshold, totalBorrowed)
    var healthFactor= totalCollateralThreshold  / totalBorrowed;
    var borrowingInfo = {
      "user_id"  :  user.id,
      "healthFactor"   :  healthFactor,
      "max_collateralSymbol" : max_collateralSymbol,
      "max_borrowedSymbol" : max_borrowedSymbol,
      "max_borrowedPrincipal" : max_borrowedPrincipal,
      "max_borrowedPriceInEth" : max_borrowedPriceInEth,
      "max_collateralBonus" : max_collateralBonus/10000,
      "max_collateralPriceInEth" : max_collateralPriceInEth,
      "total_collateral": totalCollateral,
      "total_collateral_threshold": totalCollateralThreshold,
      "total_borrowed":  totalBorrowed,
      "profit_potentialInEth": TOKEN_LIST[max_borrowedSymbol] ? max_borrowedPrincipal * allowedLiquidation * (max_collateralBonus-1) * max_borrowedPriceInEth / 10 ** TOKEN_LIST[max_borrowedSymbol].decimals : 0
    }
    if (healthFactor<=healthFactorMax) {
      loans.push(borrowingInfo)
    }
    all_loans.push(borrowingInfo)
    
  });

  //filter out loans under a threshold that we know will not be profitable (liquidation_threshold)
  loans = loans.filter(loan => TOKEN_LIST[loan.max_borrowedSymbol]);
  loans = loans.filter(loan => loan.profit_potentialInEth >= profit_threshold)
  return {
    unhealthyLoans: loans,
    all_loans
  };
}
async function liquidationProfits(loans){
  loans.map(async (loan) => {
     liquidationProfit(loan)
     })
}

async function liquidationProfit(loan){
  //flash loan fee
  if(TOKEN_LIST[loan.max_collateralSymbol]){
    const flashLoanAmount = percentBigInt(BigInt(loan.max_borrowedPrincipal), allowedLiquidation)
    const flashLoanCost = percentBigInt(flashLoanAmount, FLASH_LOAN_FEE)

    //minimum amount of liquidated coins that will be paid out as profit
    var flashLoanAmountInEth = flashLoanAmount * BigInt(loan.max_borrowedPriceInEth) / BigInt(10 ** TOKEN_LIST[loan.max_borrowedSymbol].decimals)
    var flashLoanAmountInEth_plusBonus = percentBigInt(flashLoanAmountInEth,loan.max_collateralBonus) //add the bonus
    var collateralTokensFromPayout  = flashLoanAmountInEth_plusBonus * BigInt(10 ** TOKEN_LIST[loan.max_collateralSymbol].decimals) / BigInt(loan.max_collateralPriceInEth) //this is the amount of tokens that will be received as payment for liquidation and then will need to be swapped back to token of the flashloan
    var fromTokenAmount = new TokenAmount(TOKEN_LIST[loan.max_collateralSymbol], collateralTokensFromPayout)// this is the number of coins to trade (should have many 0's)
    var bestTrade = await useTradeExactIn(fromTokenAmount,TOKEN_LIST[loan.max_borrowedSymbol])
    //debt tokens after swap
    var minimumTokensAfterSwap = bestTrade ? (BigInt(bestTrade.outputAmount.numerator) * BigInt(10 ** TOKEN_LIST[loan.max_borrowedSymbol].decimals)) / BigInt(bestTrade.outputAmount.denominator) : BigInt(0)

    //total profits (bonus_after_swap - flashLoanCost).to_eth - gasFee
    var gasFee = gasCostToLiquidate() //calc gas fee
    console.log("gass fee", gasFee);
    var flashLoanPlusCost = (flashLoanCost + flashLoanAmount)
    var profitInBorrowCurrency = minimumTokensAfterSwap - flashLoanPlusCost
    var profitInEth = profitInBorrowCurrency * BigInt(loan.max_borrowedPriceInEth) / BigInt(10 ** TOKEN_LIST[loan.max_borrowedSymbol].decimals)
    var profitInEthAfterGas = (profitInEth)  - gasFee

    if (profitInEthAfterGas>0.1)
    {
      console.log("-------------------------------")
      console.log(`user_ID:${loan.user_id}`)
      console.log(`HealthFactor ${loan.healthFactor.toFixed(2)}`)
      console.log(`flashLoanAmount ${flashLoanAmount} ${loan.max_borrowedSymbol}`)
      console.log(`flashLoanAmount converted to eth ${flashLoanAmountInEth}`)
      console.log(`flashLoanAmount converted to eth plus bonus ${flashLoanAmountInEth_plusBonus}`)
      console.log(`payout in collateral Tokens ${collateralTokensFromPayout} ${loan.max_collateralSymbol}`)
      console.log(`${loan.max_borrowedSymbol} received from swap ${minimumTokensAfterSwap} ${loan.max_borrowedSymbol}`)
      bestTrade ? showPath(bestTrade) : console.log("no path")
      console.log(`flashLoanPlusCost ${flashLoanPlusCost}`)
      console.log(`gasFee ${gasFee}`)
      console.log(`profitInEthAfterGas ${Number(profitInEthAfterGas)/(10 ** 18)}eth`)
    }
  }
    //console.log(`user_ID:${loan.user_id} HealthFactor ${loan.healthFactor.toFixed(2)} allowedLiquidation ${flashLoanAmount.toFixed(2)} ${loan.max_collateralSymbol}->${loan.max_borrowedSymbol}` )
    //console.log(`minimumTokensAfterSwap ${minimumTokensAfterSwap} flashLoanCost ${flashLoanCost} gasFee ${gasFee} profit ${profit.toFixed(2)}`)




}
//returned value is in eth
function gasCostToLiquidate(){
  return BigInt(gas_cost * GAS_USED_ESTIMATE)
}
// percent is represented as a number less than 0 ie .75 is equivalent to 75%
// multiply base and percent and return a BigInt
function percentBigInt(base:BigInt,percent:decimal):BigInt {
  return BigInt(base * BigInt(percent * 10000) / 10000n)
}
function showPath(trade:Trade){
  var pathSymbol=""
  var pathAddress= []
  trade.route.path.map(async (token) => {
     pathSymbol+=token.symbol+"->"
     pathAddress.push(token.address)
     })
  pathSymbol=pathSymbol.slice(0,-2)
  console.log(`${pathSymbol} ${JSON.stringify(pathAddress)}`)
  return [pathSymbol,pathAddress]
}


async function analyzeUnhealthy(
  uiPoolDataProviderContract, poolAddressProvider,
  loans, eth_price
  ) {
  for(let loan of loans){
    let currentTimestamp = parseInt(Date.now() / 1000);
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
      poolAddressProvider, loan.user_id
    );

    userReserveData = userReserveData.map(x => {
      let item = {
        ...x
      }
      return convertFieldsToBigNumber(item);
    })

    let userData = formatUserSummary({
      currentTimestamp,
      marketReferencePriceInUsd: "100000000",
      marketReferenceCurrencyDecimals: 8,
      userReserves: userReserveData,
      formattedReserves,
      userEmodeCategoryId: userEmodeCategoryId,
    });
    
    //format object to send the parseUser function to compute current healthFactor related and needed data.
    const reservesReformatted = userData.userReservesData.map((reserve) => {

      return {
        //currentTotalDebt: parseFloat(reserve.totalBorrows) * 10 ** reserve.reserve.decimals,
        currentTotalDebt: (parseFloat(reserve.stableBorrows) + parseFloat(reserve.variableBorrows))* 10 ** reserve.reserve.decimals,
        currentATokenBalance: parseFloat(reserve.underlyingBalance) * 10 ** reserve.reserve.decimals,
        //currentTotalDebt: (parseFloat(reserve.stableBorrowsMarketReferenceCurrency) + parseFloat(reserve.variableBorrowsMarketReferenceCurrency))* 10 ** reserve.reserve.decimals,
        //currentATokenBalance: parseFloat(reserve.underlyingBalanceMarketReferenceCurrency) * 10 ** reserve.reserve.decimals,
        eModeCategoryId: userData.eModeCategoryId? {id: userData.eModeCategoryId} : undefined,
        reserve: {
          usageAsCollateralEnabled: reserve.reserve.usageAsCollateralEnabled,
          reserveLiquidationThreshold: parseFloat(reserve.reserve.reserveLiquidationThreshold.toString()) ,
          reserveLiquidationBonus: parseFloat(reserve.reserve.reserveLiquidationBonus.toString()),
          borrowingEnabled: reserve.reserve.borrowingEnabled,
          symbol: reserve.reserve.symbol,
          underlyingAsset: reserve.underlyingAsset,
          price:{
            priceInEth: parseFloat(reserve.reserve.priceInUSD) * 10 ** 8,
            orig: parseFloat(reserve.reserve.priceInUSD),
            eth_price: eth_price
          },
          decimals: reserve.reserve.decimals,
          eMode: reserve.reserve.eModeCategoryId ? {
            id: reserve.reserve.eModeCategoryId,
            liquidationThreshold: reserve.reserve.eModeLiquidationThreshold
          }: undefined
        }
      }
    })
    //console.log("formatted ",reservesReformatted[0]);
    let userDataReformatted = {
      users: [
        {
          borrowReserve: reservesReformatted.filter(
            x => parseFloat(x.currentTotalDebt) > 0
          ),
          collateralReserve: reservesReformatted.filter(
            x => parseFloat(x.currentATokenBalance) > 0
          ),
          id: loan.user_id
        }
      ],
      
    }
    /*if (true || loan.user_id == '0xfee26a46856a93b2559d29bd2d80d3cf7d1ba24e'){
      console.log("result ", userDataReformatted);
      console.log("br ", userDataReformatted.users[0].borrowReserve);
      if(userDataReformatted.users[0].borrowReserve[0].reserve)
        console.log("br ", userDataReformatted.users[0].borrowReserve[0].reserve.price);
    }*/
    const result = parseUsers(userDataReformatted);
    
    
    //console.log("formatted user data ", userSummary)

    //const userData = await poolContract.getUserAccountData(user);
    //console.log("userData ", userData);
    console.log(
      "user: ", loan.user_id,
      "graph health factor: ", loan.healthFactor.toFixed(2),
      "contract health factor: ", parseFloat(userData.healthFactor).toFixed(2),
      "updated contract health factor", result.all_loans[0].healthFactor.toFixed(2),
      "potential profit: $", (loan.profit_potentialInEth * eth_price / 10 ** 18).toFixed(2),
      "total collateral: ", loan.total_collateral,
      "total collateral threshold", loan.total_collateral_threshold,
      "total borrowed: ", loan.total_borrowed
    )

    if(loan.user_id == '0xfa59336cfb8df4f4ef08a5a0e724f09eb64e6742'){
        console.log("borrows", userDataReformatted.users[0].borrowReserve.length, userDataReformatted.users[0].borrowReserve, userDataReformatted.users[0].borrowReserve[0].reserve.price)
        
        console.log("collateral", userDataReformatted.users[0].collateralReserve.length, userDataReformatted.users[0].collateralReserve, userDataReformatted.users[0].collateralReserve[0].reserve.price)
    }
  }
}
