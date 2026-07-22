import Safepay from "@sfpy/node-core";

const safepay = new Safepay(process.env.SAFEPAY_SECRET_KEY, {
  authType: "secret",
  host: "https://sandbox.api.getsafepay.com",
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { orderId, amountPKR } = req.body;
  if (!orderId || !amountPKR) {
    return res.status(400).json({ error: "Missing orderId or amountPKR" });
  }

  try {
    const session = await safepay.payments.session.setup({
      merchant_api_key: process.env.SAFEPAY_PUBLIC_KEY,
      intent: "CYBERSOURCE",
      mode: "payment",
      entry_mode: "raw",
      currency: "PKR",
      amount: Math.round(amountPKR * 100),
      metadata: { order_id: orderId },
    });

    const trackerToken = session?.data?.tracker?.token;
    if (!trackerToken) {
      return res.status(500).json({ error: "Failed to create session", details: session });
    }

    const authToken = await safepay.auth.passport.create();

    const origin = `https://${req.headers.host}`;
    const checkoutUrl = safepay.checkouts.payment.create({
      tracker: trackerToken,
      tbt: authToken?.data,
      environment: "sandbox",
      source: "hosted",
      redirect_url: `${origin}/?safepay_order=${orderId}&tracker=${trackerToken}`,
      cancel_url: `${origin}/?safepay_order=${orderId}&tracker=${trackerToken}&cancelled=1`,
    });

    return res.status(200).json({ url: checkoutUrl, tracker: trackerToken });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
