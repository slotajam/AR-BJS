// Secure NFC integration point.
//
// A plain NFC tag holding a static URL is NOT sufficient: it can be cloned.
// Supported tags must produce a cryptographically authenticated, per-read
// message (for example NXP NTAG 424 DNA "SUN" messages: encrypted UID +
// read counter + truncated AES-CMAC). Verifying such a message requires:
//   * per-tag keys held only on the backend (ideally in an HSM/KMS),
//   * checking the CMAC and decrypting the UID/counter,
//   * rejecting any counter <= the last accepted counter (replay),
//   * binding the accepted read to the active inspection session.
//
// No verifier is configured in this build, and none is simulated. Until a
// real verifier is implemented and hardware-tested, every call returns
// { supported: false } and the event keeps nfc_status = 'not_used' /
// 'unsupported'. The UI never shows "Secure tag authenticated" in that case.
//
// To integrate: implement verifySunMessage() against the tag vendor's
// specification and test vectors, set NFC_VERIFIER=<name>, store key
// references (not keys) in nfc_tags.key_ref, and update last_counter
// atomically inside the event submission transaction.

function verifierConfigured() {
  return false;
}

// eslint-disable-next-line no-unused-vars
function verifySunMessage({ tag, message, session }) {
  return {
    supported: false,
    authenticated: false,
    reason: 'Secure NFC verification is not configured on this server. Hardware, tag keys and a backend verifier are required.',
  };
}

module.exports = { verifierConfigured, verifySunMessage };
