import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

import SentinelRegistryModule from "./SentinelRegistry.js";

// Base mainnet USDC. Override with --parameters for other networks
// (e.g. Base Sepolia testnet USDC).
const DEFAULT_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export default buildModule("SentinelPaymentModule", (m) => {
  const usdcAddress = m.getParameter("usdcAddress", DEFAULT_USDC_ADDRESS);
  const { registry } = m.useModule(SentinelRegistryModule);

  const payment = m.contract("SentinelPayment", [usdcAddress, registry]);

  // Wire the payment contract as an authorized reporter so payAndVerify()
  // can call registry.verify() without a separate manual step post-deploy.
  m.call(registry, "setAuthorizedReporter", [payment, true]);

  return { registry, payment };
});
