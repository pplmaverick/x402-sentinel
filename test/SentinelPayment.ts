import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

describe("SentinelPayment", function () {
  const VERIFICATION_PRICE = 1_000n; // 0.001 USDC, 6 decimals

  async function deployPaymentFixture() {
    const [owner, payer, subject] = await ethers.getSigners();

    const registry = await ethers.deployContract("SentinelRegistry");
    const usdc = await ethers.deployContract("MockUSDC");
    const payment = await ethers.deployContract("SentinelPayment", [
      await usdc.getAddress(),
      await registry.getAddress(),
    ]);

    await registry.setAuthorizedReporter(await payment.getAddress(), true);
    await usdc.mint(payer.address, VERIFICATION_PRICE * 10n);

    return { registry, usdc, payment, owner, payer, subject };
  }

  it("stores the usdc and registry addresses passed at deployment", async function () {
    const { payment, usdc, registry } = await networkHelpers.loadFixture(deployPaymentFixture);

    expect(await payment.usdc()).to.equal(await usdc.getAddress());
    expect(await payment.registry()).to.equal(await registry.getAddress());
  });

  it("pulls the fee via transferFrom and forwards to registry.verify()", async function () {
    const { payment, usdc, registry, payer, subject } = await networkHelpers.loadFixture(
      deployPaymentFixture,
    );

    await usdc.connect(payer).approve(await payment.getAddress(), VERIFICATION_PRICE);

    await expect(payment.connect(payer).payAndVerify(subject.address))
      .to.emit(payment, "PaymentReceived")
      .withArgs(payer.address, subject.address, VERIFICATION_PRICE)
      .and.to.emit(payment, "VerificationForwarded")
      .withArgs(subject.address, true);

    // Confirm registry.verify() actually ran: a receipt was recorded for `subject`.
    expect(await registry.receiptCount()).to.equal(1n);
    const receiptIds = await registry.getReceiptIdsBySubject(subject.address);
    expect(receiptIds.length).to.equal(1);

    expect(await usdc.balanceOf(await payment.getAddress())).to.equal(VERIFICATION_PRICE);
  });

  it("reverts when the payer has not approved the USDC transfer", async function () {
    const { payment, payer, subject } = await networkHelpers.loadFixture(deployPaymentFixture);

    await expect(payment.connect(payer).payAndVerify(subject.address)).to.be.revertedWith(
      "MockUSDC: insufficient allowance",
    );
  });
});
