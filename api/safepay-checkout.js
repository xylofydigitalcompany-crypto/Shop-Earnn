export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { orderId, amountPKR } = req.body;

  if (!orderId || !amountPKR) {
    return res.status(400).json({ error: "Missing orderId or amountPKR" });
  }

  try {
    const sessionRes = await fetch("https://sandbox.api.getsafepay.com/order/payments/v1/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        merchant_api_key: process.env.SAFEPAY_PUBLIC_KEY,
        intent: "CYBERSOURCE",
        mode: "payment",
        entry_mode: "raw",
        currency: "PKR",
        amount: Math.round(amountPKR * 100),
        metadata: { order_id: orderId }
      })
    });

    const sessionData = await sessionRes.json();

    if (!sessionData?.data?.tracker?.token) {
      return res.status(500).json({ error: "Failed to create session", details: sessionData });
    }

    const trackerToken = sessionData.data.tracker.token;

    const checkoutUrl = `https://sandbox.gosafepay.com/checkout/?tracker=${trackerToken}&env=sandbox`;

    return res.status(200).json({ url: checkoutUrl, tracker: trackerToken });

  } catch (err) {
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
