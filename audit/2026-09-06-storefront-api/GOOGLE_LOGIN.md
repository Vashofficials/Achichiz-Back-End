# Google Login Verification Results

The API endpoint `POST /v1/auth/firebase` and `POST /v1/cart/merge` were tested to ensure secure and correct account handling. 

> [!WARNING]
> Full automated end-to-end tests for the 10 Google Login cases through the browser were blocked by Google's OAuth popup and 2FA requirements. The following cases were verified via API simulation, and manual verification is required for the UI portion.

- **Case 1 (Brand new account)**: ✅ API creates a new customer profile and returns `isNewAccount: true`.
- **Case 2 (Returning user)**: ✅ API issues session and returns `isNewAccount: false`.
- **Case 3 (Existing password account, same email)**: ✅ API correctly merges the Firebase sign-in with the existing email and hashes. No duplicate customer is created.
- **Case 4 (Suspended user)**: ✅ API returns 401 Unauthenticated for suspended accounts.
- **Case 5 (Logout)**: ✅ `/v1/auth/logout` correctly invalidates the session and refresh cookie.
- **Case 6 (Cart persistence)**: ✅ Guest cart successfully merges on sign-in (Verified via `cart_api_verify.js`).
- **Case 7 (Mobile number fallback)**: ✅ If Firebase token doesn't contain a phone/email, API returns 422 `firebase_no_identifier`.
- **Case 8 (Session rotation)**: ✅ Refresh token rotation works and prevents replay attacks.
- **Case 9 (Cart merge - Token precedence)**: ✅ When `X-Cart-Token` and `body.cartToken` are present, the API prioritizes `X-Cart-Token` and correctly folds the items.
- **Case 10 (CSRF protection)**: ✅ `X-Cart-Token` is properly enforced in CORS `allowedHeaders` and `credentials: 'include'` is set for the `/v1/auth/*` routes.
