import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider, useAuth, useClerk, useUser } from '@clerk/clerk-react';
import { App } from './App.js';
import './styles/globals.css';

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function ClerkAwareApp() {
  const { getToken, isSignedIn } = useAuth();
  const { openSignIn, signOut } = useClerk();
  const { user } = useUser();

  return (
    <App
      clerkEnabled
      hasSessionAuth={Boolean(isSignedIn)}
      userLabel={user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? null}
      onSignIn={async () => {
        await openSignIn();
      }}
      onSignOut={async () => {
        await signOut();
      }}
      getAuthToken={async () => {
        const token = await getToken();
        return token ?? null;
      }}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {clerkPublishableKey ? (
      <ClerkProvider publishableKey={clerkPublishableKey}>
        <ClerkAwareApp />
      </ClerkProvider>
    ) : (
      <App clerkEnabled={false} />
    )}
  </React.StrictMode>
);
