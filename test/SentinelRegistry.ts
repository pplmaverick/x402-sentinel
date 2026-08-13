import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

describe("SentinelRegistry", function () {
  async function deployRegistryFixture() {
    const [owner, reporter, other, subject] = await ethers.getSigners();
    const registry = await ethers.deployContract("SentinelRegistry");
    return { registry, owner, reporter, other, subject };
  }

  it("sets the deployer as owner", async function () {
    const { registry, owner } = await networkHelpers.loadFixture(deployRegistryFixture);
    expect(await registry.owner()).to.equal(owner.address);
  });

  it("allows the owner to add and remove an address from the blacklist", async function () {
    const { registry, owner, subject } = await networkHelpers.loadFixture(deployRegistryFixture);

    await expect(registry.addToBlacklist(subject.address))
      .to.emit(registry, "Blacklisted")
      .withArgs(subject.address, owner.address);
    expect(await registry.isBlacklisted(subject.address)).to.equal(true);

    await expect(registry.removeFromBlacklist(subject.address))
      .to.emit(registry, "RemovedFromBlacklist")
      .withArgs(subject.address, owner.address);
    expect(await registry.isBlacklisted(subject.address)).to.equal(false);
  });

  it("allows the owner to update trust score within bounds", async function () {
    const { registry, owner, subject } = await networkHelpers.loadFixture(deployRegistryFixture);

    expect(await registry.getTrustScore(subject.address)).to.equal(50n);

    await expect(registry.updateTrustScore(subject.address, 80n))
      .to.emit(registry, "TrustScoreUpdated")
      .withArgs(subject.address, 50n, 80n, owner.address);
    expect(await registry.getTrustScore(subject.address)).to.equal(80n);

    await expect(registry.updateTrustScore(subject.address, 101n)).to.be.revertedWith(
      "SentinelRegistry: score exceeds max",
    );
  });

  it("reverts when an unauthorized address calls verify()", async function () {
    const { registry, other, subject } = await networkHelpers.loadFixture(deployRegistryFixture);

    await expect(registry.connect(other).verify(subject.address)).to.be.revertedWith(
      "SentinelRegistry: caller is not an authorized reporter",
    );
  });

  it("allows verify() once the caller is set as an authorized reporter", async function () {
    const { registry, reporter, subject } = await networkHelpers.loadFixture(deployRegistryFixture);

    await registry.setAuthorizedReporter(reporter.address, true);

    await expect(registry.connect(reporter).verify(subject.address))
      .to.emit(registry, "Verified")
      .withArgs(subject.address, reporter.address, true, 50n, 0n);

    expect(await registry.receiptCount()).to.equal(1n);
  });
});
