import React from 'react';
import { LabLeaseGuard } from './shell';
import { GrcCompliancePage } from './pages/GrcCompliancePage';

export default function App(): React.ReactElement {
  return (
    <LabLeaseGuard
      labSlug="grc-compliance"
      labTitle="Continuous Compliance & BNM RMiT / ISO 27001 Mapper"
    >
      <GrcCompliancePage
        onBack={() => {
          window.location.href =
            window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
              ? 'http://localhost:5173/'
              : 'https://0trust.dev/';
        }}
      />
    </LabLeaseGuard>
  );
}
