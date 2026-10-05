// Razorpay Standard Checkout: create an order on our server, open Razorpay's payment window, then send the result back
// to our server to be verified. The key id comes from the server with each order; the key secret never reaches here.
import { api, ApiError, type Me } from './session'

declare global {
  interface Window { Razorpay?: any }
}

interface Order {
  order_id: string
  amount: number
  currency: string
  key_id: string
  name: string
  description: string
  prefill: { name: string; email: string }
  days: number
}

export type PayResult =
  | { status: 'paid'; me: Me }
  | { status: 'cancelled'; error?: string }   // closed the window; error = the last failed attempt, if any

let loading: Promise<void> | null = null
let busy = false

/** True while a payment is in progress, so menus behind Razorpay's window don't close on its clicks. */
export const paymentInProgress = () => busy

/** Razorpay's checkout script, loaded the first time someone pays rather than on every page view. */
export function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve()
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => { loading = null; reject(new ApiError('checkout_load', "Razorpay's payment window couldn't load. Check your connection, or turn off an ad blocker for this site, and try again.", 0)) }
    document.head.appendChild(s)
  })
  return loading
}

/** Runs the whole payment. Throws ApiError with a message to show when something goes wrong. */
export async function payWithRazorpay(): Promise<PayResult> {
  busy = true
  try {
    return await checkout()
  } finally {
    busy = false
  }
}

async function checkout(): Promise<PayResult> {
  const [order] = await Promise.all([api<Order>('/api/create-order', { body: {} }), loadCheckout()])
  return new Promise<PayResult>((resolve, reject) => {
    let lastError: string | undefined
    let settled = false
    const rzp = new window.Razorpay({
      key: order.key_id,
      amount: order.amount,
      currency: order.currency,
      name: order.name,
      description: order.description,
      order_id: order.order_id,
      prefill: { name: order.prefill.name, email: order.prefill.email },
      notes: { plan: `${order.days} days` },
      theme: { color: '#ffb547' },
      handler: async (r: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
        settled = true
        try {
          const me = await api<Me>('/api/verify-payment', { body: {
            razorpay_payment_id: r.razorpay_payment_id,
            razorpay_order_id: r.razorpay_order_id,
            razorpay_signature: r.razorpay_signature,
          } })
          resolve({ status: 'paid', me })
        } catch (err) {
          reject(err instanceof ApiError ? err : new ApiError('verify_failed',
            `Your payment went through but we couldn't confirm it just now. Don't pay again: contact us with payment ID ${r.razorpay_payment_id}.`, 0))
        }
      },
      modal: {
        confirm_close: true,
        ondismiss: () => { if (!settled) resolve({ status: 'cancelled', error: lastError }) },
      },
    })
    // a failed attempt (declined card, wrong UPI PIN...): Razorpay keeps its window open so the person can retry
    rzp.on('payment.failed', (r: { error?: { description?: string; reason?: string } }) => {
      lastError = r.error?.description || 'The payment failed.'
    })
    rzp.open()
  })
}
