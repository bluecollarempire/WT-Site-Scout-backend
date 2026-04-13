import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send('Webhook Error: ' + err.message);
  }
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    await supabase.from('orders').update({ status: 'payment_confirmed' })
      .eq('payment_intent_id', pi.id).catch(() => {});
  }
  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    await supabase.from('orders').update({ status: 'payment_failed' })
      .eq('payment_intent_id', pi.id).catch(() => {});
  }
  return res.status(200).json({ received: true })
