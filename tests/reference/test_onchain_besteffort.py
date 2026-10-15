"""Best-effort, READ-ONLY: Redis history (reference model) vs latest on-chain TrustScoreUpdated.

Differences are REPORTED, never failed: Redis can legitimately be ahead of or behind the
chain (tx failure after recordResult, a probe cycle since the last write). Only a missing
environment skips. Redis: KEYS/LRANGE only. Chain: eth_getLogs/eth_blockNumber/eth_getBlockByNumber only.
Run from repo root: python3 tests/reference/test_onchain_besteffort.py
"""
import json
import os
import sys
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import reference_model as ref  # noqa: E402

ENV_FILE = os.path.join(HERE, "../../oracle/.env")
REGISTRY = "0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f"
# keccak256("TrustScoreUpdated(address,uint256,uint256,address)")
TOPIC = "0x03204ae04bf1c609093523a6af4ae628076712e8c17e54029deb5aa38700e098"
PREFIX = "x402-sentinel:reliability-history:"
CYCLE_S = 6 * 3600
LOOKBACK_BLOCKS = int(os.environ.get("LOOKBACK_BLOCKS", 9000))  # ~5h on Base (2s blocks); free public nodes are non-archive beyond ~10k blocks. Set ONCHAIN_RPC_URL (archive) + LOOKBACK_BLOCKS=12000 to cover a full 6h cycle
CHUNK = 1000
READ_ONLY_REDIS = {"KEYS", "LRANGE", "LLEN"}


def load_env():
    env = {}
    try:
        with open(ENV_FILE) as f:
            for line in f:
                if "=" in line and not line.lstrip().startswith("#"):
                    k, v = line.rstrip("\n").split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


def redis_cmd(env, *cmd):
    assert cmd[0].upper() in READ_ONLY_REDIS, f"refusing non-read command {cmd[0]}"
    req = urllib.request.Request(env["KV_REST_API_URL"], data=json.dumps(list(cmd)).encode(),
                                 headers={"Authorization": f"Bearer {env['KV_REST_API_TOKEN']}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)["result"]


def rpc(url, method, params, retries=6):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json",
                                                              "User-Agent": "Mozilla/5.0 sentinel-ref-test"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                d = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
        time.sleep(0.3)
        if "error" in d:
            raise RuntimeError(d["error"])
        return d["result"]


def pick_rpc(env):
    """First endpoint that can serve a small getLogs. mainnet.base.org (the oracle's RPC_URL) rate-limits
    getLogs hard, so prefer ONCHAIN_RPC_URL, then public read-only nodes, then RPC_URL."""
    cands = [os.environ.get("ONCHAIN_RPC_URL"), "https://base-rpc.publicnode.com", "https://base.llamarpc.com",
             env.get("RPC_URL")]
    for url in [c for c in cands if c]:
        try:
            h = int(rpc(url, "eth_blockNumber", [], retries=1), 16)
            rpc(url, "eth_getLogs", [{"address": REGISTRY, "topics": [TOPIC],
                                      "fromBlock": hex(h - 100), "toBlock": hex(h)}], retries=1)
            return url
        except Exception:
            continue
    raise unittest.SkipTest("no RPC endpoint could serve eth_getLogs (set ONCHAIN_RPC_URL)")


class TestOnchainBestEffort(unittest.TestCase):
    def test_report(self):
        env = load_env()
        if not all(k in env for k in ("KV_REST_API_URL", "KV_REST_API_TOKEN")):
            self.skipTest("oracle/.env missing KV_REST_API_URL / KV_REST_API_TOKEN")
        env["RPC_URL"] = pick_rpc(env)

        head = int(rpc(env["RPC_URL"], "eth_blockNumber", []), 16)
        latest = {}  # subject -> (block, newScore)
        for lo in range(head - LOOKBACK_BLOCKS, head + 1, CHUNK):
            hi = min(lo + CHUNK - 1, head)
            logs = rpc(env["RPC_URL"], "eth_getLogs", [{"address": REGISTRY, "topics": [TOPIC],
                                                      "fromBlock": hex(lo), "toBlock": hex(hi)}])
            for lg in logs:
                subj = "0x" + lg["topics"][1][-40:]
                blk = int(lg["blockNumber"], 16)
                new_score = int(lg["data"][2 + 64:2 + 128], 16)  # data = oldScore, newScore
                if subj not in latest or blk >= latest[subj][0]:
                    latest[subj] = (blk, new_score)

        keys = redis_cmd(env, "KEYS", PREFIX + "*")
        now = time.time()
        matched, differ, ineligible, no_event = [], [], [], []
        for key in sorted(keys):
            subj = key[len(PREFIX):].lower()
            hist = [int(v) for v in redis_cmd(env, "LRANGE", key, 0, -1)]
            ref_score = ref.score_of_history(hist)
            if subj not in latest:
                no_event.append({"subject": subj, "ref": ref_score, "samples": len(hist)})
                continue
            blk, chain = latest[subj]
            ts = int(rpc(env["RPC_URL"], "eth_getBlockByNumber", [hex(blk), False])["timestamp"], 16)
            age = now - ts
            row = {"subject": subj, "samples": len(hist), "chain": chain, "ref": ref_score, "age_h": round(age / 3600, 2)}
            # "history unchanged since write" cannot be proven (no timestamps in Redis); proxy: the write is
            # younger than one cycle, so no later probe should have touched the history yet.
            if age > CYCLE_S:
                ineligible.append(row)
            elif chain == ref_score:
                matched.append(row)
            else:
                differ.append(row)

        print(f"\n[onchain] subjects in Redis={len(keys)} events found={len(latest)}")
        print(f"[onchain] eligible & match={len(matched)}  eligible & DIFFER={len(differ)}  "
              f"stale-write (excluded, >6h)={len(ineligible)}  no recent event={len(no_event)}")
        for r in differ:
            print("  DIFFER", r)
        for r in ineligible:
            print("  stale ", r)
        # deliberately no assertion on differences
        self.assertTrue(True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
