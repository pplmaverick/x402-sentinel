// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SentinelRegistry
/// @notice On-chain reputation/verification registry for x402 payment counterparties.
///         Authorized reporters (e.g. SentinelPayment) call verify() to check an address
///         against the blacklist and log a VerificationReceipt for audit purposes.
contract SentinelRegistry {
    struct VerificationReceipt {
        address subject;
        bool passed;
        uint256 trustScoreAtVerification;
        uint256 timestamp;
    }

    uint256 public constant DEFAULT_TRUST_SCORE = 50;
    uint256 public constant MAX_TRUST_SCORE = 100;

    address public owner;

    mapping(address => bool) public authorizedReporters;
    mapping(address => bool) public blacklist;
    mapping(address => uint256) public trustScore;
    mapping(address => uint256) public reportCount;
    mapping(address => bool) private _initialized;

    VerificationReceipt[] public receipts;
    mapping(address => uint256[]) public receiptsBySubject;

    event Verified(address indexed subject, address indexed reporter, bool passed, uint256 trustScore, uint256 receiptId);
    event ReportSubmitted(address indexed subject, address indexed reporter, string reason, uint256 newReportCount);
    event Blacklisted(address indexed subject, address indexed by);
    event RemovedFromBlacklist(address indexed subject, address indexed by);
    event TrustScoreUpdated(address indexed subject, uint256 oldScore, uint256 newScore, address indexed by);
    event ReporterAuthorized(address indexed reporter, bool authorized);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "SentinelRegistry: caller is not owner");
        _;
    }

    modifier onlyAuthorizedReporter() {
        require(
            authorizedReporters[msg.sender] || msg.sender == owner,
            "SentinelRegistry: caller is not an authorized reporter"
        );
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "SentinelRegistry: new owner is zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Grants or revokes permission to call verify()/submitReport() on behalf of the protocol.
    ///         Must be called with a payment contract's address before that contract can forward verify() calls.
    function setAuthorizedReporter(address reporter, bool authorized) external onlyOwner {
        require(reporter != address(0), "SentinelRegistry: zero reporter address");
        authorizedReporters[reporter] = authorized;
        emit ReporterAuthorized(reporter, authorized);
    }

    function addToBlacklist(address subject) external onlyOwner {
        require(subject != address(0), "SentinelRegistry: zero subject address");
        blacklist[subject] = true;
        emit Blacklisted(subject, msg.sender);
    }

    function removeFromBlacklist(address subject) external onlyOwner {
        blacklist[subject] = false;
        emit RemovedFromBlacklist(subject, msg.sender);
    }

    /// @notice Sets an absolute trust score for `subject`, bounded to [0, MAX_TRUST_SCORE].
    function updateTrustScore(address subject, uint256 newScore) external onlyOwner {
        require(newScore <= MAX_TRUST_SCORE, "SentinelRegistry: score exceeds max");
        _ensureInitialized(subject);
        uint256 oldScore = trustScore[subject];
        trustScore[subject] = newScore;
        emit TrustScoreUpdated(subject, oldScore, newScore, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Reporter-facing
    // ---------------------------------------------------------------------

    /// @notice Checks `subject` against the blacklist and records a timestamped receipt.
    /// @dev Called by authorized reporters (e.g. SentinelPayment.payAndVerify). Does not itself
    ///      move funds; payment is handled upstream by the caller.
    function verify(address subject) external onlyAuthorizedReporter returns (bool passed) {
        require(subject != address(0), "SentinelRegistry: zero subject address");
        _ensureInitialized(subject);

        passed = !blacklist[subject];

        uint256 receiptId = receipts.length;
        receipts.push(
            VerificationReceipt({
                subject: subject,
                passed: passed,
                trustScoreAtVerification: trustScore[subject],
                timestamp: block.timestamp
            })
        );
        receiptsBySubject[subject].push(receiptId);

        emit Verified(subject, msg.sender, passed, trustScore[subject], receiptId);
    }

    /// @notice Logs a report of bad behavior against `subject`. Does not itself change trustScore;
    ///         score adjustments go through updateTrustScore() so they stay an explicit, auditable step.
    function submitReport(address subject, string calldata reason) external onlyAuthorizedReporter {
        require(subject != address(0), "SentinelRegistry: zero subject address");
        _ensureInitialized(subject);
        reportCount[subject] += 1;
        emit ReportSubmitted(subject, msg.sender, reason, reportCount[subject]);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function isBlacklisted(address subject) external view returns (bool) {
        return blacklist[subject];
    }

    function getTrustScore(address subject) external view returns (uint256) {
        return _initialized[subject] ? trustScore[subject] : DEFAULT_TRUST_SCORE;
    }

    function receiptCount() external view returns (uint256) {
        return receipts.length;
    }

    function getReceiptIdsBySubject(address subject) external view returns (uint256[] memory) {
        return receiptsBySubject[subject];
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _ensureInitialized(address subject) internal {
        if (!_initialized[subject]) {
            trustScore[subject] = DEFAULT_TRUST_SCORE;
            _initialized[subject] = true;
        }
    }
}
