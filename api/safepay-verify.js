import Safepay from "@sfpy/node-core";

const safepay = new Safepay(process.env.SAFEPAY_SECRET_KEY, {
  authType: "secret",
  host: "https://sandbox.api.getsafepay.com",
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { tracker } = req.body;
  if (!tracker) {
    return res.status(400).json({ error: "Missing tracker" });
  }

  try {
    const result = await safepay.reporter.payments.fetch(tracker);
    const state = result?.data?.tracker?.state;
    return res.status(200).json({ paid: state === "TRACKER_ENDED", state });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
