import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'My Google AI Studio App',
  description: 'My Google AI Studio App',
  // Discourage browser translation extensions from rewriting the DOM, which breaks
  // React's ability to update dynamic values (e.g. slider readouts freeze).
  other: { google: 'notranslate' },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" translate="no" className="notranslate" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
