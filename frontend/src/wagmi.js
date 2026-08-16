import { createConfig } from 'wagmi'
import { base } from 'wagmi/chains'
import { getDefaultConfig } from 'connectkit'

const WALLETCONNECT_PROJECT_ID = '52e05de4cbf8da5ae04387b3c39c38a9'

export const config = createConfig(
  getDefaultConfig({
    chains: [base],
    walletConnectProjectId: WALLETCONNECT_PROJECT_ID,
    appName: 'x402 Sentinel',
    appDescription: 'The first AI Agent security firewall for x402 on Base.',
  })
)
