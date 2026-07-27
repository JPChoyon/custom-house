import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "react-router";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const title =
    status === 404
      ? "Page not found"
      : status === 401
        ? "Please sign in again"
        : status === 403
          ? "Access denied"
          : "Something went wrong";
  const message =
    status === 404
      ? "The page you requested could not be found."
      : status === 401
        ? "Your session may have expired. Please sign in and try again."
        : status === 403
          ? "You do not have permission to access this page."
          : "We could not complete this request. Please try again.";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title}</title>
      </head>
      <body>
        <main
          style={{
            maxWidth: 680,
            margin: "64px auto",
            padding: 24,
            fontFamily: "Inter, system-ui, sans-serif",
          }}
        >
          <h1>{title}</h1>
          <p>{message}</p>
          <a href="/">Return to the app</a>
        </main>
        <Scripts />
      </body>
    </html>
  );
}
