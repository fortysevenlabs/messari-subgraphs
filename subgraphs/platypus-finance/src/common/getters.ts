import { BigInt } from "@graphprotocol/graph-ts";
import { Address, BigDecimal, ethereum } from "@graphprotocol/graph-ts";
import {
  Token,
  DexAmmProtocol,
  LiquidityPool,
  UsageMetricsDailySnapshot,
  UsageMetricsHourlySnapshot,
  FinancialsDailySnapshot,
  LiquidityPoolDailySnapshot,
  LiquidityPoolHourlySnapshot,
  _LiquidityPoolParamsHelper,
  _Asset,
  RewardToken,
  LiquidityPoolFee,
  _LiquidityPoolAssetTokenHelper,
} from "../../generated/schema";
import { fetchTokenSymbol, fetchTokenName, fetchTokenDecimals } from "./tokens";
import {
  Network,
  PROTOCOL_ADMIN,
  ProtocolType,
  BIGDECIMAL_ZERO,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  poolDetail,
  RewardTokenType,
  LiquidityPoolFeeType,
  BIGINT_ZERO,
  ZERO_ADDRESS,
} from "../common/constants";
import { exponentToBigDecimal } from "./utils/numbers";
import { getUsdPrice } from "../prices";
import { Versions } from "../versions";

export function getOrCreateToken(event: ethereum.Event, tokenAddress: Address): Token {
  let token = Token.load(tokenAddress.toHexString());
  // fetch info if null
  if (!token) {
    token = new Token(tokenAddress.toHexString());
    token.symbol = fetchTokenSymbol(tokenAddress);
    token.name = fetchTokenName(tokenAddress);
    token.decimals = fetchTokenDecimals(tokenAddress);
    token.lastPriceUSD = BIGDECIMAL_ZERO;
    token.lastPriceBlockNumber = event.block.number;
  }

  if (token.lastPriceBlockNumber && token.lastPriceBlockNumber! < event.block.number) {
    token.lastPriceUSD = getUsdPrice(tokenAddress, BigDecimal.fromString("1"));
    if (!token.lastPriceUSD) {
      token.lastPriceUSD = BIGDECIMAL_ZERO;
    }
    token.lastPriceBlockNumber = event.block.number;
  }

  token.save();
  return token;
}

export function getOrCreateLiquidityPoolParamsHelper(
  event: ethereum.Event,
  poolAddress: Address,
): _LiquidityPoolParamsHelper {
  let poolParam = _LiquidityPoolParamsHelper.load(poolAddress.toHexString());

  if (!poolParam) {
    poolParam = new _LiquidityPoolParamsHelper(poolAddress.toHexString());
    poolParam.SlippageParamsK = BigDecimal.fromString("0.00002e18");
    poolParam.SlippageParamsN = BigDecimal.fromString("7");
    poolParam.SlippageParamsC1 = BigDecimal.fromString("376927610599998308");
    poolParam.SlippageParamsXThreshold = BigDecimal.fromString("329811659274998519");
    poolParam.HaircutRate = BigDecimal.fromString("0.0003e18");
    poolParam.RetentionRatio = exponentToBigDecimal(18);
    poolParam.PriceDeviation = BigDecimal.fromString("0.02e18");
    poolParam.updateBlockNumber = event.block.number;
    poolParam.save();
  }

  return poolParam;
}

function getOrCreateLiquidityPoolFeeType(feeType: string, poolAddress: Address): LiquidityPoolFee {
  const id = feeType.concat("-").concat(poolAddress.toHexString());
  let liquidityPoolFee = LiquidityPoolFee.load(id);
  if (!liquidityPoolFee) {
    liquidityPoolFee = new LiquidityPoolFee(id);
    liquidityPoolFee.feeType = feeType;
    liquidityPoolFee.save();
  }
  return liquidityPoolFee;
}

function getOrCreateLiquidityPoolFeeTypes(poolAddress: Address): string[] {
  const tradingFee = getOrCreateLiquidityPoolFeeType(LiquidityPoolFeeType.FIXED_TRADING_FEE, poolAddress);
  const withdrawFee = getOrCreateLiquidityPoolFeeType(LiquidityPoolFeeType.WITHDRAWAL_FEE, poolAddress);
  const depositFee = getOrCreateLiquidityPoolFeeType(LiquidityPoolFeeType.DEPOSIT_FEE, poolAddress);
  return [tradingFee.id, withdrawFee.id, depositFee.id];
}

function addPoolToProtocol(poolId: string, ignore: bool): void {
  const protocol = getOrCreateDexAmm();
  const _pools: string[] = protocol.pools;

  if (!ignore && !_pools.includes(poolId)) {
    _pools.push(poolId);
    protocol.pools = _pools.sort();
    protocol.totalPoolCount = _pools.length;
    protocol.save();
  }
}

export function getTokenHelperId(poolAddress: Address, tokenAddress: Address): string {
  return poolAddress.toHexString().concat("-").concat(tokenAddress.toHexString());
}

function indexAssetForPoolToken(poolAddress: Address, assetAddress: Address, tokenAddress: Address): void {
  const id = getTokenHelperId(poolAddress, tokenAddress);
  let helper = _LiquidityPoolAssetTokenHelper.load(id);
  if (!helper) {
    helper = new _LiquidityPoolAssetTokenHelper(id);
    helper.asset = assetAddress.toHexString();
    helper.save();
  }
}

export function getOrCreateAssetPool(
  event: ethereum.Event,
  assetAddress: Address,
  poolAddress: Address,
  tokenAddress: Address,
): LiquidityPool {
  const poolId = assetAddress.toHexString();
  let pool = LiquidityPool.load(poolId);

  if (!pool) {
    pool = new LiquidityPool(poolId);
    pool.poolAddress = poolAddress.toHexString();
    pool.protocol = PROTOCOL_ADMIN;
    pool.fees = getOrCreateLiquidityPoolFeeTypes(poolAddress);

    const token = getOrCreateToken(event, tokenAddress);
    const detail: poolDetail = poolDetail.fromAddress(poolAddress.toHexString());

    pool.name = token.symbol.concat(" on ").concat(detail.name);
    pool.symbol = token.symbol.concat("-").concat(detail.symbol);
    pool.inputTokens = [token.id];
    pool.outputToken = getOrCreateToken(event, assetAddress).id;
    pool.inputTokenBalances = [BIGINT_ZERO];
    pool._ignore = detail.ignore;
    pool.isSingleSided = true;
    pool.createdBlockNumber = event.block.number;
    pool.createdTimestamp = event.block.timestamp;
    pool.inputTokenWeights = [BigDecimal.fromString("100")];
    pool.totalValueLockedUSD = BIGDECIMAL_ZERO;
    pool.cumulativeSupplySideRevenueUSD = BIGDECIMAL_ZERO;
    pool.cumulativeProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
    pool.cumulativeTotalRevenueUSD = BIGDECIMAL_ZERO;
    pool.cumulativeVolumeUSD = BIGDECIMAL_ZERO;

    pool.save();

    indexAssetForPoolToken(poolAddress, assetAddress, tokenAddress);
    addPoolToProtocol(poolId, pool._ignore);
  }

  return pool;
}

export function getAssetAddressForPoolToken(
  event: ethereum.Event,
  poolAddress: Address,
  tokenAddress: Address,
): Address {
  const id = getTokenHelperId(poolAddress, tokenAddress);
  const helper = _LiquidityPoolAssetTokenHelper.load(id);
  if (helper) {
    return Address.fromString(helper.asset);
  }
  return ZERO_ADDRESS;
}

export function getOrCreateDailyUsageMetricSnapshot(event: ethereum.Event): UsageMetricsDailySnapshot {
  // Number of days since Unix epoch
  const id: i64 = event.block.timestamp.toI64() / SECONDS_PER_DAY;

  // Create unique id for the day
  let usageMetrics = UsageMetricsDailySnapshot.load(id.toString());

  if (!usageMetrics) {
    usageMetrics = new UsageMetricsDailySnapshot(id.toString());
    usageMetrics.protocol = PROTOCOL_ADMIN;
    usageMetrics.dailyActiveUsers = 0;
    usageMetrics.cumulativeUniqueUsers = 0;
    usageMetrics.dailyTransactionCount = 0;
    usageMetrics.dailyDepositCount = 0;
    usageMetrics.dailyWithdrawCount = 0;
    usageMetrics.dailySwapCount = 0;
    usageMetrics.totalPoolCount = 0;
    usageMetrics.blockNumber = event.block.number;
    usageMetrics.timestamp = event.block.timestamp;
    usageMetrics.save();
  }

  return usageMetrics;
}

export function getOrCreateHourlyUsageMetricSnapshot(event: ethereum.Event): UsageMetricsHourlySnapshot {
  // " { # of hours since Unix epoch time } "
  const id: i64 = event.block.timestamp.toI64() / SECONDS_PER_HOUR;

  // Create unique id for the day
  let usageMetrics = UsageMetricsHourlySnapshot.load(id.toString());

  if (!usageMetrics) {
    usageMetrics = new UsageMetricsHourlySnapshot(id.toString());
    usageMetrics.protocol = PROTOCOL_ADMIN;
    usageMetrics.hourlyActiveUsers = 0;
    usageMetrics.cumulativeUniqueUsers = 0;
    usageMetrics.hourlyTransactionCount = 0;
    usageMetrics.hourlyDepositCount = 0;
    usageMetrics.hourlyWithdrawCount = 0;
    usageMetrics.hourlySwapCount = 0;
    usageMetrics.blockNumber = event.block.number;
    usageMetrics.timestamp = event.block.timestamp;

    usageMetrics.save();
  }

  return usageMetrics;
}

export function getOrCreateLiquidityPoolDailySnapshot(
  event: ethereum.Event,
  assetAddress: Address,
  poolAddress: Address,
  tokenAddress: Address,
): LiquidityPoolDailySnapshot {
  const timestamp: i64 = event.block.timestamp.toI64() / SECONDS_PER_DAY;
  const id: string = assetAddress.toHexString().concat("-").concat(timestamp.toString());

  let poolDailyMetrics = LiquidityPoolDailySnapshot.load(id);

  if (!poolDailyMetrics) {
    const pool = getOrCreateAssetPool(event, assetAddress, poolAddress, tokenAddress);
    poolDailyMetrics = new LiquidityPoolDailySnapshot(id);
    poolDailyMetrics.protocol = PROTOCOL_ADMIN;
    poolDailyMetrics.pool = pool.id;
    poolDailyMetrics.blockNumber = event.block.number;
    poolDailyMetrics.timestamp = event.block.timestamp;
    poolDailyMetrics.inputTokenWeights = pool.inputTokenWeights;
    poolDailyMetrics.inputTokenBalances = pool.inputTokenBalances;
    poolDailyMetrics.totalValueLockedUSD = pool.totalValueLockedUSD;
    poolDailyMetrics.cumulativeSupplySideRevenueUSD = pool.cumulativeSupplySideRevenueUSD;
    poolDailyMetrics.cumulativeProtocolSideRevenueUSD = pool.cumulativeProtocolSideRevenueUSD;
    poolDailyMetrics.cumulativeTotalRevenueUSD = pool.cumulativeTotalRevenueUSD;
    poolDailyMetrics.cumulativeVolumeUSD = pool.cumulativeVolumeUSD;
    poolDailyMetrics.outputTokenSupply = pool.outputTokenSupply;
    poolDailyMetrics.stakedOutputTokenAmount = pool.stakedOutputTokenAmount;
    poolDailyMetrics.rewardTokenEmissionsAmount = pool.rewardTokenEmissionsAmount;
    poolDailyMetrics.rewardTokenEmissionsUSD = pool.rewardTokenEmissionsUSD;

    poolDailyMetrics.dailyVolumeByTokenAmount = [BIGINT_ZERO];
    poolDailyMetrics.dailyVolumeByTokenUSD = [BIGDECIMAL_ZERO];

    poolDailyMetrics.dailySupplySideRevenueUSD = BIGDECIMAL_ZERO;
    poolDailyMetrics.dailyProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
    poolDailyMetrics.dailyTotalRevenueUSD = BIGDECIMAL_ZERO;
    poolDailyMetrics.dailyVolumeUSD = BIGDECIMAL_ZERO;

    poolDailyMetrics.save();
  }

  return poolDailyMetrics;
}

export function getOrCreateLiquidityPoolHourlySnapshot(
  event: ethereum.Event,
  assetAddress: Address,
  poolAddress: Address,
  tokenAddress: Address,
): LiquidityPoolHourlySnapshot {
  const timestamp: i64 = event.block.timestamp.toI64() / SECONDS_PER_HOUR;
  const id: string = assetAddress.toHexString().concat("-").concat(timestamp.toString());

  let poolHourlyMetrics = LiquidityPoolHourlySnapshot.load(id);

  if (!poolHourlyMetrics) {
    const pool = getOrCreateAssetPool(event, assetAddress, poolAddress, tokenAddress);
    poolHourlyMetrics = new LiquidityPoolHourlySnapshot(id);
    poolHourlyMetrics.protocol = PROTOCOL_ADMIN;
    poolHourlyMetrics.pool = pool.id;
    poolHourlyMetrics.blockNumber = event.block.number;
    poolHourlyMetrics.timestamp = event.block.timestamp;
    poolHourlyMetrics.inputTokenWeights = pool.inputTokenWeights;

    poolHourlyMetrics.inputTokenBalances = pool.inputTokenBalances;
    poolHourlyMetrics.totalValueLockedUSD = pool.totalValueLockedUSD;
    poolHourlyMetrics.cumulativeSupplySideRevenueUSD = pool.cumulativeSupplySideRevenueUSD;
    poolHourlyMetrics.cumulativeProtocolSideRevenueUSD = pool.cumulativeProtocolSideRevenueUSD;
    poolHourlyMetrics.cumulativeTotalRevenueUSD = pool.cumulativeTotalRevenueUSD;
    poolHourlyMetrics.cumulativeVolumeUSD = pool.cumulativeVolumeUSD;
    poolHourlyMetrics.outputTokenSupply = pool.outputTokenSupply;
    poolHourlyMetrics.stakedOutputTokenAmount = pool.stakedOutputTokenAmount;
    poolHourlyMetrics.rewardTokenEmissionsAmount = pool.rewardTokenEmissionsAmount;
    poolHourlyMetrics.rewardTokenEmissionsUSD = pool.rewardTokenEmissionsUSD;

    poolHourlyMetrics.hourlyVolumeByTokenAmount = [BIGINT_ZERO];
    poolHourlyMetrics.hourlyVolumeByTokenUSD = [BIGDECIMAL_ZERO];
    poolHourlyMetrics.hourlySupplySideRevenueUSD = BIGDECIMAL_ZERO;
    poolHourlyMetrics.hourlyProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
    poolHourlyMetrics.hourlyTotalRevenueUSD = BIGDECIMAL_ZERO;
    poolHourlyMetrics.hourlyVolumeUSD = BIGDECIMAL_ZERO;

    poolHourlyMetrics.save();
  }

  return poolHourlyMetrics;
}

export function getOrCreateFinancialsDailySnapshot(event: ethereum.Event): FinancialsDailySnapshot {
  // Number of days since Unix epoch
  const id: i64 = event.block.timestamp.toI64() / SECONDS_PER_DAY;

  let financialMetrics = FinancialsDailySnapshot.load(id.toString());

  if (!financialMetrics) {
    financialMetrics = new FinancialsDailySnapshot(id.toString());
    financialMetrics.protocol = PROTOCOL_ADMIN;

    financialMetrics.blockNumber = event.block.number;
    financialMetrics.timestamp = event.block.timestamp;
    financialMetrics.totalValueLockedUSD = BIGDECIMAL_ZERO;
    financialMetrics.dailyVolumeUSD = BIGDECIMAL_ZERO;
    financialMetrics.cumulativeVolumeUSD = BIGDECIMAL_ZERO;
    financialMetrics.dailySupplySideRevenueUSD = BIGDECIMAL_ZERO;
    financialMetrics.cumulativeSupplySideRevenueUSD = BIGDECIMAL_ZERO;
    financialMetrics.dailyProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
    financialMetrics.cumulativeProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
    financialMetrics.dailyTotalRevenueUSD = BIGDECIMAL_ZERO;
    financialMetrics.cumulativeTotalRevenueUSD = BIGDECIMAL_ZERO;

    financialMetrics.save();
  }
  return financialMetrics;
}

///////////////////////////
///// DexAmm Specific /////
///////////////////////////

export function getOrCreateDexAmm(): DexAmmProtocol {
  let protocol = DexAmmProtocol.load(PROTOCOL_ADMIN);

  if (!protocol) {
    protocol = new DexAmmProtocol(PROTOCOL_ADMIN);
    protocol.name = "Platypus Finance";
    protocol.slug = "platypus-finance";
    protocol.network = Network.AVALANCHE;
    protocol.type = ProtocolType.EXCHANGE;
    protocol.totalValueLockedUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeVolumeUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeSupplySideRevenueUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeTotalRevenueUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeUniqueUsers = 0;
    protocol.totalPoolCount = 0;
    protocol.pools = [];
  }

  protocol.schemaVersion = Versions.getSchemaVersion();
  protocol.subgraphVersion = Versions.getSubgraphVersion();
  protocol.methodologyVersion = Versions.getMethodologyVersion();

  protocol.save();

  return protocol;
}

export function getOrCreateAsset(event: ethereum.Event, tokenAddress: Address, assetAddress: Address): _Asset {
  const id = assetAddress.toHexString();

  let _asset = _Asset.load(id);
  // fetch info if null
  if (!_asset) {
    _asset = new _Asset(id);
    _asset.symbol = fetchTokenSymbol(assetAddress);
    _asset.name = fetchTokenName(assetAddress);
    _asset.decimals = fetchTokenDecimals(assetAddress);
    _asset.token = tokenAddress.toHexString();
    _asset.blockNumber = event.block.number;
    _asset.timestamp = event.block.timestamp;
    _asset.cash = BigInt.zero();
    _asset.amountStaked = BIGINT_ZERO;
    _asset.rewardTokens = [];
    _asset.rewardTokenEmissionsAmount = [];
    _asset.rewardTokenEmissionsUSD = [];
    _asset.save();
  }

  return _asset;
}

export function getOrCreateRewardToken(event: ethereum.Event, tokenAddress: Address): RewardToken {
  const id = RewardTokenType.DEPOSIT.concat("-").concat(tokenAddress.toHexString());
  let rewardToken = RewardToken.load(id);
  if (!rewardToken) {
    rewardToken = new RewardToken(id);
    rewardToken.type = RewardTokenType.DEPOSIT;
    rewardToken.token = getOrCreateToken(event, tokenAddress).id;
    rewardToken.save();
  }
  return rewardToken;
}
