import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("SentinelRegistryModule", (m) => {
  const registry = m.contract("SentinelRegistry");

  return { registry };
});
