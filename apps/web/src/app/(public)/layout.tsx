import { BrandLockup } from "@omniralph/ui";

/**
 * Public pages anyone with the link may open (review links, `/share/{token}`): styled like
 * the signed-out pages, with the brand lockup but no link into the app.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="or-root auth-main">
      <div className="share-column">
        <BrandLockup className="auth-lockup" />
        {children}
      </div>
    </main>
  );
}
