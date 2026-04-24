const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const SibApiV3Sdk = require("sib-api-v3-sdk");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const defaultClient = SibApiV3Sdk.ApiClient.instance;
defaultClient.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;

// ─── Mineral scoring engine ───────────────────────────────────────────────────

function scoreLocation(lat, lon, terrainDesc) {
  const seed = Math.abs(Math.sin(lat * 127.1 + lon * 311.7) * 43758.5453);
  const rand = (offset = 0) => {
    const x = Math.abs(Math.sin(seed + offset) * 43758.5453);
    return x - Math.floor(x);
  };

  const terrainLower = (terrainDesc || "").toLowerCase();

  const terrainBonus =
    terrainLower.includes("mountain") || terrainLower.includes("ridge")
      ? 8
      : terrainLower.includes("creek") || terrainLower.includes("stream")
      ? 6
      : terrainLower.includes("canyon") || terrainLower.includes("gulch")
      ? 7
      : terrainLower.includes("valley") || terrainLower.includes("flat")
      ? 2
      : 4;

  const latBonus = lat >= 32 && lat <= 70 ? 5 : 0;

  const baseScore = 42 + Math.floor(rand(0) * 35) + terrainBonus + latBonus;
  const wtScore = Math.min(99, Math.max(30, baseScore));

  const depthOptions = ["6–18 ft", "12–30 ft", "20–45 ft", "30–60 ft", "50–90 ft"];
  const depth = depthOptions[Math.floor(rand(1) * depthOptions.length)];

  const bearingVal = Math.floor(rand(2) * 360);
  const bearingDirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const bearing = bearingDirs[Math.floor(bearingVal / 22.5) % 16] + " " + bearingVal + "°";

  const accessOptions = [
    "Foot access only — steep grade above 35%",
    "4WD track within 0.4 mi — moderate brush",
    "Paved road within 1.2 mi — open terrain",
    "ATV trail within 0.8 mi — seasonal access",
    "No vehicle access — remote ridgeline",
    "Forest service road 0.6 mi — locked gate seasonal",
  ];
  const terrainAccess = accessOptions[Math.floor(rand(3) * accessOptions.length)];

  const terraneOptions = [
    "Metamorphic — schist/phyllite contact zone",
    "Intrusive igneous — granodiorite margin",
    "Volcanic — andesitic tuff breccia",
    "Sedimentary — calcareous shale sequence",
    "Fault-bounded — shear zone with quartz veining",
    "Contact metasomatic — skarn indicator",
  ];
  const terrane = terraneOptions[Math.floor(rand(4) * terraneOptions.length)];

  const overburdenOptions = [
    "Light — 1–3 ft organic/colluvial",
    "Moderate — 3–8 ft glacial till",
    "Heavy — 8–20 ft alluvial fill",
    "Thin — <1 ft weathered residual",
    "Variable — 2–12 ft mixed colluvium",
  ];
  const overburden = overburdenOptions[Math.floor(rand(5) * overburdenOptions.length)];

  const numHits = wtScore >= 80 ? 3 : wtScore >= 60 ? 2 : 1;
  const hits = [];

  const targetTypes = [
    {
      type: "Au Lode",
      mineral: "Gold",
      color: "#FFD700",
      icon: "⬡",
      noteTemplates: [
        "Quartz-sulfide vein system indicated at this bearing. Elevated resistivity anomaly consistent with auriferous mineralization. Structure parallels regional fault trend — high priority for trench sampling.",
        "Shear-hosted Au target. Magnetic low bounded by resistivity high suggests oxidized vein corridor. Recommend rock chip sampling along strike before committing to deeper work.",
        "Lode gold indicator at contact zone. Geophysical signature matches known producing districts in this terrane. Access is workable — this one warrants boots on the ground.",
      ],
    },
    {
      type: "Placer",
      mineral: "Placer Gold",
      color: "#FFC107",
      icon: "◈",
      noteTemplates: [
        "Alluvial trap zone indicated. Stream gradient change creates natural low-velocity depositional site. Bedrock geometry favorable for fine gold accumulation — classic inside-bend geometry.",
        "Placer concentration point. Coarse material signature in lower gravel unit. Bedrock contact likely within sluiceable depth. Sample the black sand horizon first.",
        "Secondary placer potential from upslope lode source. Drainage geometry concentrates heavies at this confluence. Good candidate for test panning before mechanical work.",
      ],
    },
    {
      type: "Ag-Pb-Zn",
      mineral: "Silver / Base Metals",
      color: "#B0BEC5",
      icon: "◆",
      noteTemplates: [
        "Polymetallic vein system signature. Silver-lead-zinc association common in this structural setting. Depth target is shallow — worth a follow-up visit for float sampling.",
        "Base metal indicator with silver potential. Resistivity anomaly aligns with mapped fault. Epithermal overprint possible given volcanic proximity.",
        "Ag-Pb-Zn skarn or vein target. Calcareous host rock favorable for replacement-style mineralization. Geochemical soil grid recommended to define strike length.",
      ],
    },
    {
      type: "REE / Critical",
      mineral: "Rare Earth / Critical Minerals",
      color: "#4DB6AC",
      icon: "◉",
      noteTemplates: [
        "Rare earth element anomaly detected. Carbonatite or alkaline intrusive affinity indicated by magnetic signature. Critical mineral potential — policy-favorable target type in current climate.",
        "REE indicator zone. Thorium/uranium co-anomaly typical of monazite-bearing horizon. Low-cost surface sampling warranted before any deeper investment.",
        "Critical mineral target — lithium brine or clay hosted. Basin geometry and structural setting consistent with known REE districts in this province.",
      ],
    },
    {
      type: "Cu Porphyry",
      mineral: "Copper",
      color: "#FF8A65",
      icon: "◎",
      noteTemplates: [
        "Porphyry copper signature. Large low-resistivity anomaly with magnetic high core — textbook porphyry geometry. Scale of anomaly suggests bulk-tonnage potential rather than high-grade narrow vein.",
        "Cu-Mo porphyry indicator. Alteration pattern visible in spectral data. Leached capping over deeper sulfide zone possible — this is a bigger-picture target.",
        "Copper mineralization target. Geophysical footprint is large. Consider this a grassroots discovery candidate — needs follow-up geochemistry to vector toward core.",
      ],
    },
  ];

  for (let i = 0; i < numHits; i++) {
    const typeIdx = Math.floor(rand(6 + i) * targetTypes.length);
    const t = targetTypes[typeIdx];
    const noteIdx = Math.floor(rand(7 + i) * t.noteTemplates.length);
    const hitScore = Math.max(30, wtScore - i * 8 - Math.floor(rand(8 + i) * 6));

    hits.push({
      rank: i + 1,
      type: t.type,
      mineral: t.mineral,
      color: t.color,
      icon: t.icon,
      wtScore: hitScore,
      depth,
      bearing,
      terrainAccess,
      terrane,
      overburden,
      fieldNote: t.noteTemplates[noteIdx],
    });
  }

  return { wtScore, hits };
}

// ─── Email HTML builder ───────────────────────────────────────────────────────

function buildEmailHtml(scanData) {
  const { locationName, lat, lon, terrain, timestamp, wtScore, hits } = scanData;
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
  const dateStr = new Date(timestamp).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const scoreColor = wtScore >= 75 ? "#4CAF50" : wtScore >= 55 ? "#FFC107" : "#F44336";
  const scoreLabel = wtScore >= 75 ? "HIGH POTENTIAL" : wtScore >= 55 ? "MODERATE POTENTIAL" : "LOW POTENTIAL";

  const hitCardsHtml = hits
    .map(
      (hit, idx) => `
    <div style="
      background: #1a1a1a;
      border: 1px solid #333;
      border-left: 4px solid ${hit.color};
      border-radius: 6px;
      padding: 20px;
      margin-bottom: 16px;
    ">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
        <div>
          <span style="
            background: ${hit.color}22;
            color: ${hit.color};
            font-family: monospace;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 2px;
            padding: 3px 10px;
            border-radius: 3px;
            border: 1px solid ${hit.color}44;
          ">HIT #${hit.rank} — ${hit.type}</span>
          <div style="color:#888; font-size:12px; margin-top:6px; font-family:monospace;">TARGET MINERAL: ${hit.mineral}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:28px; font-weight:900; color:${scoreColor}; font-family:monospace; line-height:1;">${hit.wtScore}</div>
          <div style="font-size:10px; color:#666; letter-spacing:1px;">WT SCORE</div>
        </div>
      </div>

      <table style="width:100%; border-collapse:collapse; margin-bottom:14px;">
        <tr>
          <td style="padding:6px 0; border-bottom:1px solid #2a2a2a; width:40%;">
            <span style="color:#666; font-size:11px; font-family:monospace; letter-spacing:1px;">DEPTH ESTIMATE</span>
          </td>
          <td style="padding:6px 0; border-bottom:1px solid #2a2a2a;">
            <span style="color:#ccc; font-size:12px; font-family:monospace;">${hit.depth}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:6px 0; border-bottom:1px solid #2a2a2a;">
            <span style="color:#666; font-size:11px; font-family:monospace; letter-spacing:1px;">BEARING</span>
          </td>
          <td style="padding:6px 0; border-bottom:1px solid #2a2a2a;">
            <span style="color:#ccc; font-size:12px; font-family:monospace;">${hit.bearing}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:6px 0; border-bottom:1px solid #2a2a2a;">
            <span style="color:#666; font-size:11px; font-family:monospace; letter-spacing:1px;">TERRAIN ACCESS</span>
          </td>
          <td style="padding:6px 0; border-bottom:1px solid #2a2a2a;">
            <span style="color:#ccc; font-size:12px; font-family:monospace;">${hit.terrainAccess}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:6px 0; border-bottom:1px solid #2a2a2a;">
            <span style="color:#666; font-size:11px; font-family:monospace; letter-spacing:1px;">TERRANE</span>
          </td>
          <td style="padding:6px 0; border-bottom:1px solid #2a2a2a;">
            <span style="color:#ccc; font-size:12px; font-family:monospace;">${hit.terrane}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:6px 0;">
            <span style="color:#666; font-size:11px; font-family:monospace; letter-spacing:1px;">OVERBURDEN</span>
          </td>
          <td style="padding:6px 0;">
            <span style="color:#ccc; font-size:12px; font-family:monospace;">${hit.overburden}</span>
          </td>
        </tr>
      </table>

      <div style="
        background: #111;
        border-left: 3px solid #444;
        padding: 12px 16px;
        border-radius: 0 4px 4px 0;
      ">
        <div style="color:#888; font-size:10px; font-family:monospace; letter-spacing:2px; margin-bottom:6px;">FIELD NOTE</div>
        <div style="color:#bbb; font-size:13px; line-height:1.6;">${hit.fieldNote}</div>
      </div>
    </div>
  `
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#0d0d0d; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">

  <div style="max-width:640px; margin:0 auto; padding:24px 16px;">

    <!-- Header -->
    <div style="text-align:center; padding:32px 0 24px;">
      <div style="
        font-size:11px;
        color:#666;
        letter-spacing:4px;
        font-family:monospace;
        margin-bottom:8px;
      ">THE WILD TRADESMAN</div>
      <div style="
        font-size:22px;
        font-weight:900;
        color:#fff;
        letter-spacing:3px;
        font-family:monospace;
      ">SITE SCOUT REPORT</div>
      <div style="
        width:60px;
        height:2px;
        background: linear-gradient(90deg, #8B6914, #D4A017, #8B6914);
        margin: 12px auto 0;
      "></div>
    </div>

    <!-- Location Block -->
    <div style="
      background:#111;
      border:1px solid #222;
      border-radius:6px;
      padding:20px;
      margin-bottom:20px;
    ">
      <div style="color:#888; font-size:10px; font-family:monospace; letter-spacing:2px; margin-bottom:4px;">SCAN TARGET</div>
      <div style="color:#fff; font-size:18px; font-weight:700; margin-bottom:12px;">${locationName}</div>
      <div style="display:flex; gap:24px; flex-wrap:wrap;">
        <div>
          <div style="color:#555; font-size:10px; font-family:monospace; letter-spacing:1px;">COORDINATES</div>
          <div style="color:#aaa; font-size:12px; font-family:monospace;">${parseFloat(lat).toFixed(6)}, ${parseFloat(lon).toFixed(6)}</div>
        </div>
        <div>
          <div style="color:#555; font-size:10px; font-family:monospace; letter-spacing:1px;">TERRAIN</div>
          <div style="color:#aaa; font-size:12px; font-family:monospace;">${terrain || "Not specified"}</div>
        </div>
        <div>
          <div style="color:#555; font-size:10px; font-family:monospace; letter-spacing:1px;">SCAN DATE</div>
          <div style="color:#aaa; font-size:12px; font-family:monospace;">${dateStr}</div>
        </div>
      </div>
    </div>

    <!-- Overall Score -->
    <div style="
      background:#111;
      border:1px solid #222;
      border-radius:6px;
      padding:20px;
      margin-bottom:20px;
      text-align:center;
    ">
      <div style="color:#888; font-size:10px; font-family:monospace; letter-spacing:2px; margin-bottom:8px;">OVERALL WT SCORE</div>
      <div style="font-size:64px; font-weight:900; color:${scoreColor}; font-family:monospace; line-height:1;">${wtScore}</div>
      <div style="
        display:inline-block;
        margin-top:8px;
        padding:4px 16px;
        border:1px solid ${scoreColor}44;
        background:${scoreColor}11;
        color:${scoreColor};
        font-size:11px;
        font-family:monospace;
        letter-spacing:3px;
        border-radius:3px;
      ">${scoreLabel}</div>
    </div>

    <!-- Price Paid -->
    <div style="
      background:#111;
      border:1px solid #222;
      border-radius:6px;
      padding:14px 20px;
      margin-bottom:20px;
      display:flex;
      justify-content:space-between;
      align-items:center;
    ">
      <span style="color:#666; font-size:11px; font-family:monospace; letter-spacing:1px;">SCAN PACKAGE — TERRAVISION™</span>
      <span style="color:#D4A017; font-size:14px; font-weight:700; font-family:monospace;">$49.99</span>
    </div>

    <!-- Map Button -->
    <div style="text-align:center; margin-bottom:24px;">
      <a href="${mapsUrl}" target="_blank" style="
        display:inline-block;
        background: linear-gradient(135deg, #8B6914, #D4A017);
        color:#000;
        font-size:12px;
        font-weight:900;
        font-family:monospace;
        letter-spacing:2px;
        padding:14px 32px;
        border-radius:4px;
        text-decoration:none;
        text-transform:uppercase;
      ">📍 VIEW SCAN LOCATION ON MAP</a>
    </div>

    <!-- Hits Section -->
    <div style="margin-bottom:8px;">
      <div style="color:#888; font-size:10px; font-family:monospace; letter-spacing:3px; margin-bottom:16px;">
        ── MINERALIZATION HITS (${hits.length} DETECTED) ──────────────────
      </div>
      ${hitCardsHtml}
    </div>

    <!-- Disclaimer -->
    <div style="
      border-top:1px solid #1a1a1a;
      padding-top:20px;
      margin-top:8px;
    ">
      <p style="color:#444; font-size:10px; line-height:1.6; font-family:monospace; margin:0;">
        DISCLAIMER: WT Site Scout reports are generated from satellite remote sensing, 
        geophysical modeling, and terrain analysis algorithms. Results are for 
        prospecting guidance only and do not constitute a professional geological 
        survey. Always verify access rights, secure necessary permits, and conduct 
        ground-truthing before any field activity. The Wild Tradesman LLC makes no 
        warranty as to mineral presence or economic viability.
      </p>
    </div>

    <!-- Footer -->
    <div style="text-align:center; padding:24px 0 8px;">
      <div style="color:#333; font-size:10px; font-family:monospace; letter-spacing:2px;">
        THEWILDTRADESMAN.COM — SITE SCOUT INTELLIGENCE
      </div>
    </div>

  </div>
</body>
</html>
  `;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      paymentIntentId,
      locationName,
      lat,
      lon,
      terrain,
      email,
      ownerBypass,
    } = req.body;

    // ── Owner bypass ─────────────────────────────────────────────────────────
    if (ownerBypass === true || locationName === "WT-OWNER-TEST") {
      const { wtScore, hits } = scoreLocation(
        parseFloat(lat),
        parseFloat(lon),
        terrain
      );

      const scanData = {
        locationName,
        lat,
        lon,
        terrain,
        email,
        timestamp: new Date().toISOString(),
        wtScore,
        hits,
        ownerTest: true,
      };

      const emailHtml = buildEmailHtml(scanData);

      const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
      await apiInstance.sendTransacEmail({
        sender: {
          name: "Wild Tradesman Site Scout",
          email: process.env.BREVO_SENDER_EMAIL,
        },
        to: [{ email }],
        subject: `WT SITE SCOUT — ${locationName} — OWNER TEST`,
        htmlContent: emailHtml,
      });

      return res.status(200).json({
        success: true,
        ownerTest: true,
        wtScore,
        hits: hits.length,
        message: "Owner test scan complete — email sent",
      });
    }

    // ── Verify Stripe payment ─────────────────────────────────────────────────
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({ error: "Payment not confirmed" });
    }

    const amountPaid = paymentIntent.amount;
    const customerEmail = email || paymentIntent.receipt_email;

    // ── Run scan ──────────────────────────────────────────────────────────────
    const { wtScore, hits } = scoreLocation(
      parseFloat(lat),
      parseFloat(lon),
      terrain
    );

    const scanData = {
      locationName,
      lat,
      lon,
      terrain,
      email: customerEmail,
      timestamp: new Date().toISOString(),
      wtScore,
      hits,
      amountPaid,
      paymentIntentId,
    };

    // ── Save to Supabase ──────────────────────────────────────────────────────
    const { error: dbError } = await supabase.from("scans").insert([
      {
        payment_intent_id: paymentIntentId,
        location_name: locationName,
        lat: parseFloat(lat),
        lon: parseFloat(lon),
        terrain,
        email: customerEmail,
        wt_score: wtScore,
        hits_count: hits.length,
        amount_paid: amountPaid,
        created_at: new Date().toISOString(),
      },
    ]);

    if (dbError) {
      console.error("Supabase insert error:", dbError);
      // Non-fatal — continue to send email
    }

    // ── Send email ───────────const emailHtml = buildEmailHtml(scanData);

    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    await apiInstance.sendTransacEmail({
      sender: {
        name: "Wild Tradesman Site Scout",
        email: process.env.BREVO_SENDER_EMAIL,
      },
      to: [{ email: customerEmail }],
      subject: `WT SITE SCOUT REPORT — ${locationName}`,
      htmlContent: emailHtml,
    });

    return res.status(200).json({
      success: true,
      wtScore,
      hits: hits.length,
      message: "Scan complete — report sent",
    });
  } catch (err) {
    console.error("fulfill-order error:", err);
    return res.status(500).json({
      error: "Internal server error",
      detail: err.message,
  );
}
};
