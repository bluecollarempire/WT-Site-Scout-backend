import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    // Set CORS headers to allow your frontend to communicate with this API
    res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const { amount, currency } = req.body;

        // Create a PaymentIntent with the order amount and currency
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount,
            currency: currency || 'usd',
            automatic_payment_methods: { enabled: true },
        });

        res.status(200).send({
            clientSecret: paymentIntent.client_secret,
        });
    } catch (error) {
        res.status(500).json({ statusCode: 500, message: error.message });
    }
}
