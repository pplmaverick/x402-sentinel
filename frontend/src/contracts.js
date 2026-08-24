export const SENTINEL_REGISTRY_ADDRESS = '0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f'
export const SENTINEL_PAYMENT_ADDRESS = '0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953'
export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// 0.001 USDC, 6 decimals — matches SentinelPayment.VERIFICATION_PRICE.
export const VERIFICATION_PRICE = 1000n

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
]

export const SENTINEL_PAYMENT_ABI = [
  {
    type: 'function',
    name: 'payAndVerify',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'subject', type: 'address' }],
    outputs: [{ name: 'passed', type: 'bool' }],
  },
]

export const SENTINEL_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getTrustScore',
    stateMutability: 'view',
    inputs: [{ name: 'subject', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isBlacklisted',
    stateMutability: 'view',
    inputs: [{ name: 'subject', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Verified',
    inputs: [
      { name: 'subject', type: 'address', indexed: true },
      { name: 'reporter', type: 'address', indexed: true },
      { name: 'passed', type: 'bool', indexed: false },
      { name: 'trustScore', type: 'uint256', indexed: false },
      { name: 'receiptId', type: 'uint256', indexed: false },
    ],
  },
]
