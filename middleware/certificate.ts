/**
 * TRACE — Authenticity Certificate Generator (F-5)
 * Generates a Walrus-hosted HTML certificate with QR code for any registered media.
 */

import QRCode from "qrcode";
import { CONFIG } from "./traceProcessor";

export interface CertificateData {
  mediaId: string;
  blobId: string;
  suiTx: string;
  creator: string;
  timestamp: number;
  integrity: number;
  editType: number;
  aiScore: number;
  description: string;
  contentHash: string;
  revoked: boolean;
}

const INTEGRITY_LABELS: Record<number, string> = {
  0: "VERIFIED ORIGINAL",
  1: "MODIFIED",
  2: "UNVERIFIED",
  3: "AI GENERATED",
};

const INTEGRITY_COLORS: Record<number, string> = {
  0: "#34d399",
  1: "#fbbf24",
  2: "#f43f5e",
  3: "#a78bfa",
};

const EDIT_TYPE_LABELS: Record<number, string> = {
  0: "ORIGINAL", 1: "TRIM", 2: "COLOR GRADE", 3: "SUBTITLE",
  4: "AI REMIX",  5: "CROP", 6: "MERGE",       7: "TRANSLATE",
};

export async function generateCertificateHTML(data: CertificateData): Promise<string> {
  const verifyUrl = `https://trace-protocol.app/verify?hash=${data.contentHash}`;
  const suiExplorerUrl = `https://suiexplorer.com/txblock/${data.suiTx}?network=testnet`;
  const walrusUrl = `${CONFIG.WALRUS_EXPLORER}/${data.blobId}`;
  const integrityColor = INTEGRITY_COLORS[data.integrity] ?? "#94a3b8";
  const integrityLabel = INTEGRITY_LABELS[data.integrity] ?? "UNKNOWN";
  const editLabel = EDIT_TYPE_LABELS[data.editType] ?? "UNKNOWN";
  const formattedDate = new Date(data.timestamp).toUTCString();

  // Generate QR code as base64 PNG
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
    width: 200,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TRACE Certificate — ${data.mediaId.slice(0, 16)}...</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap');

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #050505;
      color: #e4e4e7;
      font-family: 'JetBrains Mono', 'Courier New', monospace;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }

    .cert {
      max-width: 720px;
      width: 100%;
      border: 1px solid #27272a;
      background: #09090b;
      border-radius: 4px;
      overflow: hidden;
    }

    .cert-header {
      border-bottom: 1px solid #27272a;
      padding: 1.5rem 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #0a0a0a;
    }

    .cert-logo {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .cert-logo-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, #34d399, #06b6d4);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      font-weight: 700;
      color: #000;
    }

    .cert-logo-text {
      font-size: 1.1rem;
      font-weight: 500;
      letter-spacing: 0.2em;
      color: #fff;
    }

    .cert-logo-sub {
      font-size: 0.6rem;
      color: #71717a;
      letter-spacing: 0.15em;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      border: 1px solid;
      border-radius: 2px;
      padding: 0.4rem 0.75rem;
      font-size: 0.65rem;
      letter-spacing: 0.15em;
      font-weight: 500;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .cert-body {
      padding: 2rem;
    }

    .cert-title {
      font-size: 0.7rem;
      letter-spacing: 0.2em;
      color: #52525b;
      margin-bottom: 0.5rem;
      text-transform: uppercase;
    }

    .cert-desc {
      font-size: 1.1rem;
      color: #fff;
      margin-bottom: 2rem;
      font-weight: 500;
    }

    .cert-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
      border: 1px solid #18181b;
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 1.5rem;
    }

    .cert-field {
      padding: 0.875rem 1rem;
      border-bottom: 1px solid #18181b;
      border-right: 1px solid #18181b;
    }

    .cert-field:nth-child(even) { border-right: none; }
    .cert-field:nth-last-child(-n+2) { border-bottom: none; }
    .cert-field.full { grid-column: 1 / -1; border-right: none; }
    .cert-field.full:last-child { border-bottom: none; }

    .field-label {
      font-size: 0.6rem;
      color: #52525b;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      margin-bottom: 0.3rem;
    }

    .field-value {
      font-size: 0.75rem;
      color: #a1a1aa;
      word-break: break-all;
      line-height: 1.4;
    }

    .field-value.highlight {
      color: #06b6d4;
    }

    .field-value.green { color: #34d399; }

    .cert-bottom {
      display: flex;
      gap: 1.5rem;
      align-items: flex-start;
    }

    .cert-qr {
      flex-shrink: 0;
      border: 1px solid #27272a;
      padding: 0.75rem;
      background: #fff;
      border-radius: 2px;
    }

    .cert-qr img { display: block; width: 120px; height: 120px; }

    .cert-qr-label {
      font-size: 0.55rem;
      color: #52525b;
      letter-spacing: 0.1em;
      text-align: center;
      margin-top: 0.5rem;
      background: #fff;
      color: #09090b;
      padding: 0 0.25rem 0.25rem;
    }

    .cert-links {
      flex: 1;
      space-y: 0.5rem;
    }

    .cert-link {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      padding: 0.75rem;
      border: 1px solid #18181b;
      border-radius: 2px;
      margin-bottom: 0.5rem;
      text-decoration: none;
      transition: border-color 0.15s;
    }

    .cert-link:hover { border-color: #34d399; }

    .cert-link-label {
      font-size: 0.55rem;
      color: #52525b;
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }

    .cert-link-value {
      font-size: 0.65rem;
      color: #06b6d4;
      word-break: break-all;
    }

    .cert-footer {
      border-top: 1px solid #18181b;
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .cert-footer-text {
      font-size: 0.55rem;
      color: #3f3f46;
      letter-spacing: 0.1em;
    }

    .revoked-banner {
      background: rgba(244, 63, 94, 0.1);
      border: 1px solid rgba(244, 63, 94, 0.3);
      color: #f43f5e;
      padding: 0.75rem 1rem;
      font-size: 0.7rem;
      letter-spacing: 0.15em;
      text-align: center;
      margin-bottom: 1.5rem;
    }
  </style>
</head>
<body>
  <div class="cert">
    <!-- Header -->
    <div class="cert-header">
      <div class="cert-logo">
        <div class="cert-logo-icon">T</div>
        <div>
          <div class="cert-logo-text">TRACE</div>
          <div class="cert-logo-sub">AUTHENTICITY CERTIFICATE</div>
        </div>
      </div>
      <div class="status-badge" style="color:${integrityColor};border-color:${integrityColor}40">
        <div class="status-dot" style="background:${integrityColor}"></div>
        ${integrityLabel}
      </div>
    </div>

    <!-- Body -->
    <div class="cert-body">
      ${data.revoked ? `<div class="revoked-banner">⚠ THIS RECORD HAS BEEN REVOKED BY THE CREATOR</div>` : ""}

      <div class="cert-title">Media Description</div>
      <div class="cert-desc">${escapeHtml(data.description || "Untitled Media")}</div>

      <div class="cert-grid">
        <div class="cert-field">
          <div class="field-label">Registration Timestamp</div>
          <div class="field-value">${formattedDate}</div>
        </div>
        <div class="cert-field">
          <div class="field-label">Edit Type</div>
          <div class="field-value">${editLabel}</div>
        </div>
        <div class="cert-field">
          <div class="field-label">AI Score</div>
          <div class="field-value">${(data.aiScore / 100).toFixed(1)}% synthetic probability</div>
        </div>
        <div class="cert-field">
          <div class="field-label">Integrity Status</div>
          <div class="field-value" style="color:${integrityColor}">${integrityLabel}</div>
        </div>
        <div class="cert-field full">
          <div class="field-label">Creator Address</div>
          <div class="field-value highlight">${data.creator}</div>
        </div>
        <div class="cert-field full">
          <div class="field-label">SHA-256 Content Hash</div>
          <div class="field-value">${data.contentHash}</div>
        </div>
        <div class="cert-field full">
          <div class="field-label">Sui Object ID</div>
          <div class="field-value highlight">${data.mediaId}</div>
        </div>
        <div class="cert-field full">
          <div class="field-label">Walrus Blob ID</div>
          <div class="field-value green">${data.blobId}</div>
        </div>
      </div>

      <!-- QR + Links -->
      <div class="cert-bottom">
        <div>
          <div class="cert-qr">
            <img src="${qrDataUrl}" alt="Verify QR Code" />
            <div class="cert-qr-label">SCAN TO VERIFY</div>
          </div>
        </div>
        <div class="cert-links">
          <a class="cert-link" href="${suiExplorerUrl}" target="_blank" rel="noopener">
            <span class="cert-link-label">Sui Transaction</span>
            <span class="cert-link-value">${data.suiTx}</span>
          </a>
          <a class="cert-link" href="${walrusUrl}" target="_blank" rel="noopener">
            <span class="cert-link-label">Walrus Storage</span>
            <span class="cert-link-value">${data.blobId}</span>
          </a>
          <a class="cert-link" href="${verifyUrl}" target="_blank" rel="noopener">
            <span class="cert-link-label">Live Verification URL</span>
            <span class="cert-link-value">${verifyUrl}</span>
          </a>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="cert-footer">
      <span class="cert-footer-text">TRACE PROTOCOL · SUI TESTNET · WALRUS STORAGE</span>
      <span class="cert-footer-text">GENERATED ${new Date().toUTCString()}</span>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}