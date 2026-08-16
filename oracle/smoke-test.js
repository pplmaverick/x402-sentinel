import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const REGISTRY_ADDRESS = '0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f';
const REGISTRY_ABI = ['function updateTrustScore(address subject, uint256 newScore) external'];

const SUBJECT = '0xed2B5717c9b936ecC76d75401026A99143e278F5';
const SCORE = 75;

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, wallet);

  console.log(`smoke test: updateTrustScore(${SUBJECT}, ${SCORE}) from ${wallet.address}`);
  const tx = await registry.updateTrustScore(SUBJECT, SCORE);
  console.log('tx hash:', tx.hash);

  const receipt = await tx.wait();
  console.log('confirmed in block:', receipt.blockNumber, 'status:', receipt.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
