// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Minimal ERC20 interface — USDC on Base is standard-compliant and returns bool,
///      so no SafeERC20 wrapper is needed here.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISentinelRegistry {
    function verify(address subject) external returns (bool passed);
}

/// @title SentinelPayment
/// @notice Charges a fixed $0.001 USDC fee per lookup, then forwards the call to
///         SentinelRegistry.verify(). Payer must have approved this contract for at
///         least VERIFICATION_PRICE beforehand (standard ERC20 approve/transferFrom flow).
/// @dev Base mainnet USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (pass as `usdcAddress`
///      at deploy time — kept as a constructor param rather than hardcoded so the same
///      bytecode can be deployed against testnets with a mock USDC).
contract SentinelPayment {
    IERC20 public immutable usdc;
    ISentinelRegistry public immutable registry;
    address public owner;

    /// @notice 0.001 USDC, expressed in USDC's 6 decimals (0.001 * 1e6).
    uint256 public constant VERIFICATION_PRICE = 1_000;

    event PaymentReceived(address indexed payer, address indexed subject, uint256 amount);
    event VerificationForwarded(address indexed subject, bool passed);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "SentinelPayment: caller is not owner");
        _;
    }

    constructor(address usdcAddress, address registryAddress) {
        require(usdcAddress != address(0), "SentinelPayment: zero USDC address");
        require(registryAddress != address(0), "SentinelPayment: zero registry address");
        usdc = IERC20(usdcAddress);
        registry = ISentinelRegistry(registryAddress);
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "SentinelPayment: new owner is zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Pulls VERIFICATION_PRICE USDC from msg.sender, then forwards to
    ///         SentinelRegistry.verify(subject). Reverts if the USDC transfer fails
    ///         (e.g. missing approval) or if this contract is not an authorized
    ///         reporter on the registry.
    function payAndVerify(address subject) external returns (bool passed) {
        require(subject != address(0), "SentinelPayment: zero subject address");

        bool received = usdc.transferFrom(msg.sender, address(this), VERIFICATION_PRICE);
        require(received, "SentinelPayment: USDC transferFrom failed");
        emit PaymentReceived(msg.sender, subject, VERIFICATION_PRICE);

        passed = registry.verify(subject);
        emit VerificationForwarded(subject, passed);
    }

    /// @notice Withdraws accumulated USDC fees to `to`. Owner-only.
    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "SentinelPayment: zero withdraw address");
        bool sent = usdc.transfer(to, amount);
        require(sent, "SentinelPayment: USDC transfer failed");
        emit Withdrawn(to, amount);
    }

    function usdcBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
