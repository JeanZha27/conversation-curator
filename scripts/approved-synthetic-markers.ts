import { createHash } from "node:crypto";

// Exact path-and-line digests for reviewed synthetic fixtures and documentation.
// Any change to a marked line requires an explicit manifest update and review.
const APPROVED_MARKER_DIGESTS: Readonly<Record<string, readonly string[]>> = {
  ".gitleaks.toml": [
    "9e7022e09153fd1293ddf7b3e372025d2653f0dfea008cfd5a1566faf6f02b30",
    "7ae52a598be9e17dcc0a28758479f5fdc9d6fadf32b3f0a4ac5d5a448fa4b51b",
    "2d9bf7f15b609db643f7989ea0f0b8f59e6b33621454e954a3d191a8499bd73c",
  ],
  "CONTRIBUTING.md": [
    "2f8fce767457108abc6c8338aea3dfbc4c7b7ef13f64f3c8ac9118cfcd8db0a2",
  ],
  "src/core/security-scanner.ts": [
    "83d3c2c43ad2e563193707b149fe775e2a3d99106df200751e778861f5238e2e",
  ],
  "scripts/package-smoke.ts": [
    "827f069a7e60d3cb104a4d64a037d5301c2137c918315b4f7c3d6190195bf9fe",
  ],
  "test/compatibility.test.ts": [
    "3e672392f42c379416776d3e1e555a1ea2e95abe68e260303023724db26946ff",
  ],
  "test/core.test.ts": [
    "a0beba8ad30591c63b2b012be44bd9d62c372e0a30565423a3ffa4a91b696fd5",
    "714d7b0b6cb2482cbf6b4bc53265dbeab2678d223f4dd76848863ff7f5fd37f8",
    "b6a8d9ebabb885f1096328fe0d666419492c3c55d2f6bb2fce3a104b81b2f81c",
    "2bcf0c44591db6885af26356472296ae7e69e8d650cfd7ab5ac0f11ab83e4185",
    "014e0e36aeacfe08aa1becf38a2cc89194be62d68a6eeb5703d217241fb40882",
    "897f2beb40d32d50a7edec98447de06a7cdf134be689c1c39a861212a58ca459",
    "87c867f9d5bd1deb9c78e8e448d93f2750cb833193b1c2ccd0aa7fe0718dbbd2",
    "31a147673b13545b714fc605a20f0b6dde1986b7774d875b3b6dde890889b57d",
    "cf726cced909e735c35deb07a2a6535ca5a8d45306708ec11a417d2093548ef5",
    "f107c553a14ff4404187df0563262a7d3baa660e4f392e0abe2c17b220d34f06",
    "16e1df7a9a183aad679a7b3d9f2a0140d468b5ed9853c539fb48544e9015afe8",
    "b29151e2d95e28c265879cb899d7049903c387872982bc4005eae952524543c2",
    "8549cfcbef497a7273850f6b258350a9f8eae2f35a60093d46fabadd5bfee89c",
    "bc03cc339601cb3e124987983650f3fbc17046fdb0754d308bb97434d6d6b860",
  ],
  "test/pipeline.test.ts": [
    "4180800c3231a648c7f18a974cf76e0958a0bbdf1ca2089bf724a05bf4125925",
    "af03df0ef4727f6f62cd165ba9d0137ba850600b3526481b03d1a061a749b343",
    "9f95c7e00cf58ec39644a274968155d1b722cc40a8331d8beb192ffd04a38f35",
    "d7fb53631e8ae3efb2f564668f707712a3ab42979158a8977c3535e153149d52",
    "f1f82fe40ccd2af2ac26ecc0f9c5531837a17625011b7524891ce5fc20b43005",
    "56a888377d99114b62535cbc0d5ebb28a5600fbcbbeade5a112e70a6cae1af4b",
    "cf37c2e791bc7a418d2ee68d9bad44a24d58e0e7cb4f6b1db1b1bec5778994cd",
    "5951906141639cbdc83fa03eb00d9154907c6dd3cc331f0c0333640575cd5e11",
    "6cce1beb678974a800d9f5b63b64ef3e4498b893b0d922e4abb162e2e21656ce",
    "e8a647e910e97c07ab8ebdc9833a113e1fc2682bb041cada1195356945db7ede",
  ],
};

export const approvedMarkerCount = Object.values(APPROVED_MARKER_DIGESTS)
  .reduce((count, digests) => count + digests.length, 0);

export function markerDigest(path: string, line: string): string {
  return createHash("sha256").update(path).update("\0").update(line).digest("hex");
}

export function isApprovedSyntheticMarker(path: string, line: string): boolean {
  return APPROVED_MARKER_DIGESTS[path]?.includes(markerDigest(path, line)) ?? false;
}
