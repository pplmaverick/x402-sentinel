# Deployment Log

## Base Sepolia (testnet)

| Contract Name    | Address | Tx Hash | Block | Timestamp |
| ----------------- | ------- | ------- | ----- | --------- |
| SentinelRegistry  | `0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f` | `0x244fc4ae67164ccb8923a714ea08e2c885d5bfda19b8faba4b85c4986922ef24` | 45419250 | 2026-08-13T07:39:48Z |
| SentinelPayment   | `0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953` | `0x24b2362fa931055a0813a9063ab0a8e7bc7c5ba964c2f21bcd57d07e5bcec4dd` | 45419266 | 2026-08-13T07:40:20Z |

Wiring: `SentinelRegistry.setAuthorizedReporter(SentinelPayment, true)` — tx `0x6462c053369fbd59667782c30325faaf2b29af0ca0fed32ce8b72180b46c3b99`, block 45419272, 2026-08-13T07:40:32Z.
USDC used: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Base Sepolia).

## Base Mainnet

| Contract Name    | Address | Tx Hash | Block | Timestamp |
| ----------------- | ------- | ------- | ----- | --------- |
| SentinelRegistry  | `0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f` | `0xecbbdd6ffb92ec2b3899b550462b184fadc9c17aa9932b8085eb952e8211c36f` | 49908957 | 2026-08-13T07:47:41Z |
| SentinelPayment   | `0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953` | `0x016fcfaff7ff9777f856069cf9ab44e73af466505a13aa2d169f5d01473bf8ba` | 49908963 | 2026-08-13T07:47:53Z |

Wiring: `SentinelRegistry.setAuthorizedReporter(SentinelPayment, true)` — tx `0x4bfd9959d2f54e97456e8e13cdd275353d3fd7187dc1e2bb2cba1b94220fa7e6`, block 49908969, 2026-08-13T07:48:05Z.
USDC used: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base mainnet).

Note: addresses are identical to the Base Sepolia deployment above — expected, same wallet/nonce sequence produces the same CREATE address across chains.
