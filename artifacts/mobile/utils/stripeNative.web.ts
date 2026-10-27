import React from "react";

export function StripeProvider(props: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement(React.Fragment, null, props.children);
}

type InitResult = { error?: { message: string } };
type PresentResult = { error?: { message: string; code?: string } };

export function useStripe(): {
  initPaymentSheet: (opts: unknown) => Promise<InitResult>;
  presentPaymentSheet: () => Promise<PresentResult>;
} {
  return {
    initPaymentSheet: async () => ({
      error: { message: "Stripe is unavailable in the web preview. Use the iOS/Android app to complete payment." },
    }),
    presentPaymentSheet: async () => ({
      error: { message: "Stripe is unavailable in the web preview.", code: "Canceled" },
    }),
  };
}
