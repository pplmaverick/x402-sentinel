import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAccount, useConfig } from 'wagmi'
import { readContract, waitForTransactionReceipt, writeContract } from 'wagmi/actions'
import { base } from 'wagmi/chains'
import { ConnectKitButton, useModal } from 'connectkit'
import { getAddress, isAddress } from 'viem'
import {
  ERC20_ABI,
  SENTINEL_PAYMENT_ABI,
  SENTINEL_PAYMENT_ADDRESS,
  SENTINEL_REGISTRY_ABI,
  SENTINEL_REGISTRY_ADDRESS,
  USDC_ADDRESS,
  VERIFICATION_PRICE,
} from './contracts'
import './App.css'

const STATUS_LABELS = {
  resolving: 'Resolving endpoint...',
  approving: 'Requesting USDC approval...',
  verifying: 'Verifying on-chain...',
  reading: 'Reading trust score...',
}

const BUSY_STATES = new Set(['resolving', 'approving', 'verifying', 'reading'])
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const HOW_IT_WORKS_STEPS = [
  {
    icon: '🔍',
    title: 'Scan Any Endpoint',
    body: 'Enter any x402 endpoint URL or payTo address. We resolve the payTo address from the live 402 response.',
  },
  {
    icon: '⚡',
    title: 'Verify On-Chain',
    body: 'Pay $0.001 USDC to trigger an on-chain verification. The result is written to Base mainnet — immutable and composable.',
  },
  {
    icon: '📊',
    title: 'Get Trust Score',
    body: 'Receive a 0–100 trust score based on endpoint health, 402 compliance, and oracle signals.',
  },
  {
    icon: '🛡️',
    title: 'Defend Your Agent',
    body: 'PASS / WARN / BLOCK — know before your agent pays. Any x402 service can query Sentinel on-chain, no API key needed.',
  },
]

function getVerdict(score) {
  if (score >= 70) return { label: 'PASS', color: '#22c55e' }
  if (score >= 40) return { label: 'WARN', color: '#eab308' }
  return { label: 'BLOCK', color: '#ef4444' }
}

function useCountUp(target, durationMs) {
  const [value, setValue] = useState(0)

  useEffect(() => {
    let raf
    const start = performance.now()

    function tick(now) {
      const progress = Math.min((now - start) / durationMs, 1)
      const eased = 1 - (1 - progress) ** 3
      setValue(Math.round(target * eased))
      if (progress < 1) raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])

  return value
}

function ParticleBackground() {
  return (
    <div className="particle-bg" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  )
}

function ShieldLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 2 4 5v6c0 5.2 3.4 9.7 8 11 4.6-1.3 8-5.8 8-11V5l-8-3Z"
        stroke="#0052FF"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="m8.5 12 2.5 2.5 4.5-5" stroke="#0052FF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TrustGauge({ score, color }) {
  const count = useCountUp(score, 1200)
  const size = 160
  const strokeWidth = 12
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - score / 100)

  return (
    <div className="gauge-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} stroke="#1f1f23" strokeWidth={strokeWidth} fill="none" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="gauge-number">{count}</div>
    </div>
  )
}

export default function App() {
  const { address, isConnected } = useAccount()
  const config = useConfig()
  const { setOpen } = useModal()

  const [inputValue, setInputValue] = useState('')
  const [scanState, setScanState] = useState('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [currentResult, setCurrentResult] = useState(null)
  const [history, setHistory] = useState([])
  const scanIdRef = useRef(0)

  const isBusy = BUSY_STATES.has(scanState)

  async function handleScan() {
    if (isBusy) return

    const raw = inputValue.trim()
    if (!raw) {
      setErrorMessage('Enter an endpoint URL or agent address.')
      return
    }

    if (!isConnected) {
      setOpen(true)
      return
    }

    setErrorMessage('')
    setCurrentResult(null)
    scanIdRef.current += 1

    try {
      let subject
      let endpointLabel = raw

      if (isAddress(raw)) {
        subject = getAddress(raw)
        if (subject === ZERO_ADDRESS) {
          throw new Error('The zero address cannot be scanned.')
        }
      } else {
        setScanState('resolving')
        const target = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
        endpointLabel = target

        const res = await fetch(`/api/resolve?url=${encodeURIComponent(target)}`)
        const data = await res.json()
        if (!data.subject) {
          throw new Error(data.error || 'Could not resolve a payTo address from this endpoint.')
        }
        subject = getAddress(data.subject)
      }

      setScanState('approving')
      const allowance = await readContract(config, {
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [address, SENTINEL_PAYMENT_ADDRESS],
        chainId: base.id,
      })

      if (allowance < VERIFICATION_PRICE) {
        const approveHash = await writeContract(config, {
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [SENTINEL_PAYMENT_ADDRESS, VERIFICATION_PRICE],
          chainId: base.id,
        })
        await waitForTransactionReceipt(config, { hash: approveHash, chainId: base.id })

        // The wallet's own RPC node may not have caught up to the just-confirmed
        // approve yet, so its pre-flight gas estimation for payAndVerify can see a
        // stale (zero) allowance and block the tx as "will revert". Give it a beat.
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }

      setScanState('verifying')
      const payHash = await writeContract(config, {
        address: SENTINEL_PAYMENT_ADDRESS,
        abi: SENTINEL_PAYMENT_ABI,
        functionName: 'payAndVerify',
        args: [subject],
        chainId: base.id,
      })
      await waitForTransactionReceipt(config, { hash: payHash, chainId: base.id })

      setScanState('reading')
      const scoreRaw = await readContract(config, {
        address: SENTINEL_REGISTRY_ADDRESS,
        abi: SENTINEL_REGISTRY_ABI,
        functionName: 'getTrustScore',
        args: [subject],
        chainId: base.id,
      })

      const score = Number(scoreRaw)
      const verdict = getVerdict(score)

      const result = {
        id: `${scanIdRef.current}-${Date.now()}`,
        endpoint: endpointLabel,
        subject,
        score,
        label: verdict.label,
        color: verdict.color,
        txHash: payHash,
        time: new Date().toLocaleTimeString('en-US'),
      }

      setCurrentResult(result)
      setHistory((prev) => [result, ...prev].slice(0, 25))
      setScanState('done')
    } catch (err) {
      console.error(err)
      setErrorMessage(err.shortMessage || err.message || 'Scan failed.')
      setScanState('error')
    }
  }

  return (
    <div className="app">
      <ParticleBackground />

      <header className="header">
        <div className="logo">
          <ShieldLogo />
          x402 Sentinel
        </div>
        <ConnectKitButton />
      </header>

      <main className="container">
        <section className="hero">
          <motion.h1
            className="hero-title"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            The first AI Agent security firewall for x402 on Base
          </motion.h1>
          <motion.p
            className="hero-sub"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            Scan any x402-enabled endpoint's payment address for an on-chain trust score before
            your agent pays it.
          </motion.p>
        </section>

        <section className="card scanner-card">
          <label htmlFor="scan-input">Endpoint URL or Agent Address</label>
          <div className="scanner-row">
            <input
              id="scan-input"
              type="text"
              placeholder="https://api.example.com or 0x..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleScan()}
              disabled={isBusy}
            />
            <button className="scan-button" onClick={handleScan} disabled={isBusy}>
              {isBusy ? <span className="spinner" /> : 'Scan Endpoint'}
            </button>
          </div>
          {errorMessage && <p className="error-text">{errorMessage}</p>}
          {!isConnected && !errorMessage && (
            <p className="hint-text">
              Connect your wallet to scan — each scan costs $0.001 USDC on Base.
            </p>
          )}
        </section>

        <AnimatePresence mode="wait">
          {(isBusy || currentResult) && (
            <motion.section
              key={scanIdRef.current}
              className="card result-card"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
            >
              {isBusy && (
                <>
                  <div className="loading-ring" />
                  <p className="result-status-label">{STATUS_LABELS[scanState]}</p>
                </>
              )}

              {!isBusy && currentResult && (
                <>
                  <TrustGauge score={currentResult.score} color={currentResult.color} />
                  <span
                    className="badge"
                    style={{ color: currentResult.color, borderColor: currentResult.color }}
                  >
                    {currentResult.label}
                  </span>
                  <p className="result-subject">
                    Subject:{' '}
                    <a
                      href={`https://basescan.org/address/${currentResult.subject}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {currentResult.subject}
                    </a>
                  </p>
                  <p className="result-tx">
                    Verification tx:{' '}
                    <a
                      href={`https://basescan.org/tx/${currentResult.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {currentResult.txHash.slice(0, 10)}...{currentResult.txHash.slice(-8)}
                    </a>
                  </p>
                </>
              )}
            </motion.section>
          )}
        </AnimatePresence>

        <motion.section
          className="how-it-works"
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        >
          <div className="how-it-works-inner">
            <h2 className="how-it-works-title">How It Works</h2>
            <div className="steps-grid">
              {HOW_IT_WORKS_STEPS.map((step) => (
                <div className="step-card" key={step.title}>
                  <span className="step-icon" aria-hidden="true">
                    {step.icon}
                  </span>
                  <h3 className="step-title">{step.title}</h3>
                  <p className="step-body">{step.body}</p>
                </div>
              ))}
            </div>
            <p className="how-it-works-footnote">
              Defending against Attack IV (Server-Selection) identified in arXiv:2605.11781
            </p>
          </div>
        </motion.section>

        <section className="card recent-scans">
          <h2>Recent Scans</h2>
          {history.length === 0 ? (
            <p className="empty-text">No scans yet — run your first scan above.</p>
          ) : (
            <div className="scan-table">
              <div className="scan-row scan-row-head">
                <span>Endpoint</span>
                <span>Score</span>
                <span>Status</span>
                <span>Time</span>
              </div>
              <AnimatePresence initial={false}>
                {history.map((item) => (
                  <motion.div
                    layout
                    key={item.id}
                    className="scan-row"
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.35, ease: 'easeOut' }}
                  >
                    <span className="scan-endpoint" title={item.endpoint}>
                      {item.endpoint}
                    </span>
                    <span className="scan-score">{item.score}</span>
                    <span
                      className="scan-badge"
                      style={{ color: item.color, borderColor: item.color }}
                    >
                      {item.label}
                    </span>
                    <span className="scan-time">{item.time}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
