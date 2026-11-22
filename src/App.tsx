import React from 'react';
import { GrcCompliancePage } from './pages/GrcCompliancePage';

export default function App(): React.ReactElement {
  return (
    <GrcCompliancePage
      onBack={() => {
        window.location.href =
          window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
            ? 'http://localhost:5173/'
            : 'https://0trust.dev/';
      }}
    />
  );
}
