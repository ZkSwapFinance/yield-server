const superagent = require('superagent');
const sdk = require('@defillama/sdk');

const utils = require('../utils');
const { comptrollerAbi, ercDelegator } = require('./abi');

const COMPTROLLER_ADDRESS = '0xa86DD95c210dd186Fa7639F93E4177E97d057576';
const CHAIN = 'arbitrum';
const GET_ALL_MARKETS = 'getAllMarkets';
const REWARD_SPEED = 'compSupplySpeeds';
const REWARD_SPEED_BORROW = 'compBorrowSpeeds';
const SUPPLY_RATE = 'supplyRatePerBlock';
const BORROW_RATE = 'borrowRatePerBlock';
const TOTAL_BORROWS = 'totalBorrows';
const GET_CHASH = 'getCash';
const UNDERLYING = 'underlying';
const BLOCKS_PER_DAY = 86400 / 12;
const PROJECT_NAME = 'lodestar-v1';

const NATIVE_TOKEN = {
  decimals: 18,
  symbol: 'WETH',
  address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'.toLowerCase(),
};

const PROTOCOL_TOKEN = {
  decimals: 18,
  symbol: 'LODE',
  address: '0xF19547f9ED24aA66b03c3a552D181Ae334FBb8DB'.toLowerCase(),
};

const getPrices = async (addresses) => {
  const prices = (
    await superagent.get(
      `https://coins.llama.fi/prices/current/${addresses
        .join(',')
        .toLowerCase()}`
    )
  ).body.coins;

  const pricesByAddress = Object.entries(prices).reduce(
    (acc, [name, price]) => ({
      ...acc,
      [name.split(':')[1]]: price.price,
    }),
    {}
  );

  return pricesByAddress;
};

const calculateApy = (ratePerTimestamps) => {
  const blocksPerDay = BLOCKS_PER_DAY;
  const daysPerYear = 365;

  return (
    (Math.pow(ratePerTimestamps * blocksPerDay + 1, daysPerYear) - 1) * 100
  );
};

const getRewards = async (markets, rewardMethod) => {
  return (
    await sdk.api.abi.multiCall({
      chain: CHAIN,
      calls: markets.map((market) => ({
        target: COMPTROLLER_ADDRESS,
        params: [market],
      })),
      abi: comptrollerAbi.find(({ name }) => name === rewardMethod),
    })
  ).output.map(({ output }) => output);
};

const multiCallMarkets = async (markets, method, abi) => {
  return (
    await sdk.api.abi.multiCall({
      chain: CHAIN,
      calls: markets.map((market) => ({ target: market })),
      abi: abi.find(({ name }) => name === method),
    })
  ).output.map(({ output }) => output);
};

const main = async () => {
  const allMarketsRes = (
    await sdk.api.abi.call({
      target: COMPTROLLER_ADDRESS,
      chain: CHAIN,
      abi: comptrollerAbi.find(({ name }) => name === GET_ALL_MARKETS),
    })
  ).output;
  const allMarkets = Object.values(allMarketsRes);

  const markets = (
    await sdk.api.abi.multiCall({
      chain: CHAIN,
      abi: comptrollerAbi.find((n) => n.name === 'markets'),
      calls: allMarkets.map((m) => ({
        target: COMPTROLLER_ADDRESS,
        params: [m],
      })),
    })
  ).output.map((o) => o.output);

  const extraRewards = await getRewards(allMarkets, REWARD_SPEED);
  const extraRewardsBorrow = await getRewards(allMarkets, REWARD_SPEED_BORROW);
  const isPaused = await getRewards(allMarkets, 'mintGuardianPaused');

  const supplyRewards = await multiCallMarkets(
    allMarkets,
    SUPPLY_RATE,
    ercDelegator
  );

  const borrowRewards = await multiCallMarkets(
    allMarkets,
    BORROW_RATE,
    ercDelegator
  );

  const marketsCash = await multiCallMarkets(
    allMarkets,
    GET_CHASH,
    ercDelegator
  );
  const totalBorrows = await multiCallMarkets(
    allMarkets,
    TOTAL_BORROWS,
    ercDelegator
  );

  const underlyingTokens = await multiCallMarkets(
    allMarkets,
    UNDERLYING,
    ercDelegator
  );

  const underlyingSymbols = await multiCallMarkets(
    underlyingTokens,
    'symbol',
    ercDelegator
  );
  const underlyingDecimals = await multiCallMarkets(
    underlyingTokens,
    'decimals',
    ercDelegator
  );

  const prices = await getPrices(
    underlyingTokens
      .concat([NATIVE_TOKEN.address])
      .map((token) => `${CHAIN}:` + token)
  );

  const lodePrices = await getPrices([`${CHAIN}:${PROTOCOL_TOKEN.address}`]);

  const pools = allMarkets.map((market, i) => {
    const token = underlyingTokens[i] || NATIVE_TOKEN.address;
    const symbol =
      // for maker
      underlyingTokens[i]?.toLowerCase() ===
      '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2'
        ? 'MKR'
        : underlyingSymbols[i] || NATIVE_TOKEN.symbol;

    const decimals = Number(underlyingDecimals[i]) || NATIVE_TOKEN.decimals;
    let price = prices[token.toLowerCase()];
    if (price === undefined)
      price = symbol.toLowerCase().includes('usd') ? 1 : 0;

    const totalSupplyUsd =
      ((Number(marketsCash[i]) + Number(totalBorrows[i])) / 10 ** decimals) *
      price;
    const tvlUsd = (marketsCash[i] / 10 ** decimals) * price;

    const totalBorrowUsd = (Number(totalBorrows[i]) / 10 ** decimals) * price;

    const apyBase = calculateApy(supplyRewards[i] / 10 ** 18);
    const apyBaseBorrow = calculateApy(borrowRewards[i] / 10 ** 18);

    const calcRewardApy = (rewards, denom) => {
      return (
        (((rewards[i] / 10 ** PROTOCOL_TOKEN.decimals) *
          BLOCKS_PER_DAY *
          365 *
          lodePrices[PROTOCOL_TOKEN.address]) /
          denom) *
        100
      );
    };
    const apyReward = calcRewardApy(extraRewards, totalSupplyUsd);
    const _apyRewardBorrow = calcRewardApy(extraRewardsBorrow, totalBorrowUsd);
    const apyRewardBorrow = isNaN(_apyRewardBorrow) ? 0 : _apyRewardBorrow;

    let poolReturned = {
      pool: market.toLowerCase(),
      chain: utils.formatChain(CHAIN),
      project: PROJECT_NAME,
      symbol,
      tvlUsd,
      apyBase,
      apyReward,
      underlyingTokens: [token],
      rewardTokens: [apyReward ? PROTOCOL_TOKEN.address : null].filter(Boolean),
    };
    if (isPaused[i] === false) {
      poolReturned = {
        ...poolReturned,
        // borrow fields
        totalSupplyUsd,
        totalBorrowUsd,
        apyBaseBorrow,
        apyRewardBorrow,
        ltv: Number(markets[i].collateralFactorMantissa) / 1e18,
      };
    }
    return poolReturned;
  });

  return pools;
};

module.exports = {
  timetravel: false,
  apy: main,
  url: 'https://app.lodestarfinance.io/',
};
