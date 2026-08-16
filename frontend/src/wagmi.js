import { createConfig } from 'wagmi'
import { base } from 'wagmi/chains'
import { getDefaultConfig } from 'connectkit'

// TODO: replace with a real WalletConnect Cloud project ID before sharing this app widely.
const WALLETCONNECT_PROJECT_ID = 'WALLETCONNECT_PROJECT_ID'

export const config = createConfig(
  getDefaultConfig({
    chains: [base],
    walletConnectProjectId: WALLETCONNECT_PROJECT_ID,
    appName: 'x402 Sentinel',
    appDescription: 'The first AI Agent security firewall for x402 on Base.',
  })
)
