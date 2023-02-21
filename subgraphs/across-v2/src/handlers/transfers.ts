import { Address, BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import { bigIntToBigDecimal } from "../sdk/util/numbers";
import {
  Network,
  RewardTokenType,
  SECONDS_PER_DAY_BI,
} from "../sdk/util/constants";
import {
  ACROSS_ACCELERATING_DISTRIBUTOR_CONTRACT,
  ACROSS_PROTOCOL_NAME,
  ACROSS_REWARD_TOKEN,
  Pricer,
  TokenInit,
} from "../util";
import { getUsdPrice } from "../prices";
import { findOriginToken } from "../availableRoutesApi";
import { Versions } from "../versions";

import { SDK } from "../sdk/protocols/bridge";
import { BridgeConfig } from "../sdk/protocols/bridge/config";
import {
  BridgePermissionType,
  BridgePoolType,
  CrosschainTokenType,
} from "../sdk/protocols/bridge/enums";

import { FilledRelay } from "../../generated/SpokePool/SpokePool";
import { AcceleratingDistributor } from "../../generated/SpokePool/AcceleratingDistributor";
import { networkToChainID } from "../sdk/protocols/bridge/chainIds";

export function handleFilledRelay(event: FilledRelay): void {
  // Config
  const conf = new BridgeConfig(
    event.address.toHexString(),
    ACROSS_PROTOCOL_NAME,
    ACROSS_PROTOCOL_NAME,
    BridgePermissionType.WHITELIST,
    Versions
  );

  const sdk = SDK.initializeFromEvent(
    conf,
    new Pricer(event.block),
    new TokenInit(),
    event
  );

  // Chain
  const originChainId = event.params.originChainId;
  const destinationChainId = event.params.destinationChainId;

  // InputToken
  const inputTokenAddress = event.params.destinationToken;
  const inputToken = sdk.Tokens.getOrCreateToken(inputTokenAddress!);

  // CrossToken
  const crossTokenAddress: Address = Address.fromString(
    findOriginToken(
      originChainId.toI32(),
      destinationChainId.toI32(),
      inputTokenAddress.toHexString()
    )
  );
  const crossToken = sdk.Tokens.getOrCreateCrosschainToken(
    originChainId,
    crossTokenAddress!,
    CrosschainTokenType.CANONICAL,
    inputTokenAddress!
  );

  // Pool
  const poolId = event.address.concat(Bytes.fromUTF8(inputToken.symbol));
  const pool = sdk.Pools.loadPool<string>(poolId);

  if (!pool.isInitialized) {
    pool.initialize(
      poolId.toString(),
      inputToken.symbol,
      BridgePoolType.LIQUIDITY,
      inputToken
    );
  }

  pool.addDestinationToken(crossToken);

  // Account
  const acc = sdk.Accounts.loadAccount(event.params.depositor);
  acc.transferIn(
    pool,
    pool.getDestinationTokenRoute(crossToken)!,
    event.params.depositor,
    event.params.amount,
    event.transaction.hash
  );

  // Revenue
  // Note: We take the amount from crossChain (origin) and multiplying by inputToken price (destination).
  // This isn't ideal but we do this because we don't have access to price for the crossToken.
  const lpFee = bigIntToBigDecimal(event.params.realizedLpFeePct);
  const supplySideRevenueAmount = bigIntToBigDecimal(event.params.amount).times(
    lpFee
  );
  const supplySideRevenue = getUsdPrice(
    inputTokenAddress,
    supplySideRevenueAmount
  );
  pool.addSupplySideRevenueUSD(supplySideRevenue);

  // Rewards
  // RewardToken can also be fetched from AcceleratingDistributor contract ("rewardToken" method)
  // Only track rewardToken emissions on mainnet where AcceleratingDistributor is deployed
  if (
    destinationChainId == networkToChainID(Network.MAINNET) &&
    event.block.number >= BigInt.fromI32(15977129)
  ) {
    const rewardTokenAddress = Address.fromString(ACROSS_REWARD_TOKEN);
    const rewardToken = sdk.Tokens.getOrCreateToken(rewardTokenAddress);

    const acceleratingDistributorContract = AcceleratingDistributor.bind(
      Address.fromString(ACROSS_ACCELERATING_DISTRIBUTOR_CONTRACT)
    );
    const contractCall =
      acceleratingDistributorContract.try_stakingTokens(rewardTokenAddress);

    let baseEmissionRate: BigInt;
    if (contractCall.reverted) {
      log.info(
        "[AcceleratingDistributor:stakingToken()] retrieve baseEmissionRate for pools call reverted",
        []
      );
    } else {
      log.error("baseEmission: {}", [
        contractCall.value.getBaseEmissionRate().toString(),
      ]);
      baseEmissionRate = contractCall.value.getBaseEmissionRate();
    }

    log.error("tx: {} baseEmissionRate: {}", [
      event.transaction.hash.toHexString(),
      baseEmissionRate!.toString(),
    ]);
    const amount = baseEmissionRate!
      .times(SECONDS_PER_DAY_BI)
      .div(BigInt.fromI32(rewardToken.decimals));
    pool.setRewardEmissions(RewardTokenType.DEPOSIT, rewardToken, amount);
  }
}
