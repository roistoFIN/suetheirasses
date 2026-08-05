import React from 'react';
import { Modal, Stack, Text, Title, List, Table, Button } from '@mantine/core';

interface PrivacyPolicyModalProps {
  opened: boolean;
  onClose: () => void;
  /** Passed in per-caller rather than imported, since each page (Home.tsx, Matchmaking.tsx)
   * defines its own local "Courtroom Ink" style tokens per the codebase's established
   * per-file duplication convention — see CLAUDE.md's *Client-side duplicated pure logic*
   * section. Only `title` (heading font) is actually used here. */
  titleStyle: React.CSSProperties;
  primaryBtnStyle: React.CSSProperties;
}

/**
 * The GDPR privacy policy modal — extracted out of Matchmaking.tsx so Home.tsx can show
 * the exact same legal text without risking two copies drifting apart. Unlike the small
 * pure UI-logic functions this codebase deliberately duplicates by hand (trend arrows,
 * deployability checks, offer brackets — see CLAUDE.md), legal text is not something a
 * "keep two copies in sync by hand" convention is safe for, so this is a real shared
 * component instead.
 */
const PrivacyPolicyModal: React.FC<PrivacyPolicyModalProps> = ({ opened, onClose, titleStyle, primaryBtnStyle }) => (
  <Modal
    opened={opened}
    onClose={onClose}
    title={<Text component="span" style={{ ...titleStyle, fontSize: '1.3rem' }}>⚖️ Privacy Policy</Text>}
    centered
    size="lg"
  >
    <Stack gap="md">
      <Text size="sm" fs="italic" style={{ color: 'var(--ink-text-soft)' }}>Last Updated: July 24, 2026</Text>

      <Text size="sm">
        This Privacy Policy describes how Sue Them Chickens ("we", "us", or "our")
        collects, uses, and protects your personal data when you play our web game at
        suethemchickens.online. We are committed to respecting your privacy and complying
        with applicable data protection laws, including the EU General Data Protection
        Regulation (GDPR) and Finnish data protection laws.
      </Text>

      <Title order={4} style={titleStyle}>1. Data Controller</Title>
      <Text size="sm">The data controller responsible for your personal data is:</Text>
      <List size="sm" spacing={2}>
        <List.Item><b>Name / Data Controller:</b> Risto Paavola</List.Item>
        <List.Item><b>Location:</b> Finland</List.Item>
        <List.Item><b>Contact Email:</b> risto.paavola@gmail.com</List.Item>
      </List>

      <Title order={4} style={titleStyle}>2. Information We Collect</Title>
      <Text size="sm">
        We only collect the minimal amount of data necessary to provide and secure the
        game, as well as to run analytics and advertisements.
      </Text>
      <Text size="sm" fw={700}>Player Identification &amp; Gameplay Data:</Text>
      <List size="sm" spacing={2}>
        <List.Item>A uniquely generated Player ID assigned to your browser session.</List.Item>
        <List.Item>Optional username chosen by you.</List.Item>
        <List.Item>In-game action logs and gameplay progress associated with your Player ID.</List.Item>
      </List>
      <Text size="sm" fw={700}>Technical &amp; Network Data:</Text>
      <List size="sm" spacing={2}>
        <List.Item>IP address.</List.Item>
        <List.Item>Technical logs (server access logs, request timestamps, error logs).</List.Item>
      </List>
      <Text size="sm" fw={700}>Cookies and Tracking Technologies:</Text>
      <List size="sm" spacing={2}>
        <List.Item>Essential cookies or local storage keys required to maintain your game session.</List.Item>
        <List.Item>Third-party cookies and tracking scripts provided by Google (see Section 5).</List.Item>
      </List>
      <Text size="sm" fw={700}>Feedback (Optional):</Text>
      <List size="sm" spacing={2}>
        <List.Item>
          If you choose to use the "Feedback" form, we collect a 1-5 satisfaction
          rating and any free-text comment you enter. This is submitted anonymously —
          it is never linked to your Player ID, username, IP address, or any other
          identifier, so it is not personal data under GDPR.
        </List.Item>
      </List>

      <Title order={4} style={titleStyle}>3. Legal Grounds and Purposes of Processing</Title>
      <Text size="sm">We process your data for the following purposes and legal bases:</Text>
      <Table striped withTableBorder withColumnBorders fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Purpose</Table.Th>
            <Table.Th>Collected Data</Table.Th>
            <Table.Th>Legal Basis (GDPR)</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td>Game Operation</Table.Td>
            <Table.Td>Player ID, optional username, gameplay logs, essential cookies</Table.Td>
            <Table.Td><b>Contract:</b> Necessary to provide the web game service to you.</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>Security &amp; Stability</Table.Td>
            <Table.Td>IP addresses, server logs, action logs</Table.Td>
            <Table.Td><b>Legitimate Interest:</b> To ensure network security, prevent abuse/cheating, and fix technical bugs.</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>Analytics &amp; Advertising</Table.Td>
            <Table.Td>Device/browser data, cookie identifiers, interaction data</Table.Td>
            <Table.Td><b>Consent:</b> Required before loading Google Analytics and Google Ads scripts via our Consent Banner.</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>Product Feedback (Optional)</Table.Td>
            <Table.Td>Satisfaction rating, optional free-text comment — no identifiers attached</Table.Td>
            <Table.Td><b>Legitimate Interest:</b> To understand player satisfaction and improve the game. As this data is fully anonymous, it does not constitute personal data under GDPR.</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>

      <Title order={4} style={titleStyle}>4. Data Storage, Location, and Retention</Title>
      <List size="sm" spacing={2}>
        <List.Item><b>Server Location:</b> Our game servers are hosted on a Hetzner Cloud VPS located in Finland (EU/EEA).</List.Item>
        <List.Item><b>Retention Period:</b> All IP addresses, server logs, player IDs, usernames, and in-game action logs are automatically and permanently deleted after 90 days.</List.Item>
        <List.Item><b>Feedback Retention:</b> Because feedback ratings/comments carry no identifier linking them to you, the 90-day deletion above does not apply to them — they may be retained indefinitely for product-improvement purposes.</List.Item>
      </List>

      <Title order={4} style={titleStyle}>5. Third-Party Services and Analytics</Title>
      <Text size="sm">
        We use third-party services provided by Google LLC / Google Ireland Limited to
        analyze website traffic and display advertisements:
      </Text>
      <List size="sm" spacing={2}>
        <List.Item><b>Google Analytics:</b> Used to collect aggregated statistical information about how players interact with the game.</List.Item>
        <List.Item><b>Google Advertising (Ads / AdSense):</b> Used to display advertisements to users.</List.Item>
      </List>
      <Text size="sm" fw={700}>Consent Management</Text>
      <Text size="sm">
        Non-essential third-party scripts (Google Analytics and Advertising) are
        blocked by default and will only load if you explicitly grant permission
        through our Consent Management Banner on your first visit. You may update or
        revoke your cookie consent at any time using the cookie settings link
        available on our website.
      </Text>
      <Text size="sm" fw={700}>International Data Transfers</Text>
      <Text size="sm">
        Google may process data outside the European Economic Area (EEA), including in
        the United States. Data transfers to Google LLC in the US are based on the
        EU-U.S. Data Privacy Framework.
      </Text>

      <Title order={4} style={titleStyle}>6. Your Data Rights Under GDPR</Title>
      <Text size="sm">Under the GDPR, you have the following rights regarding your personal data:</Text>
      <List size="sm" spacing={2}>
        <List.Item><b>Right of Access:</b> You can request a copy of the personal data we hold about you.</List.Item>
        <List.Item><b>Right to Erasure ("Right to be Forgotten"):</b> You can request that we delete your personal data.</List.Item>
        <List.Item><b>Right to Object / Restrict Processing:</b> You can object to or request restrictions on processing under certain conditions.</List.Item>
        <List.Item><b>Right to Withdraw Consent:</b> Where processing is based on consent (analytics/advertising), you can withdraw your consent at any time.</List.Item>
      </List>
      <Text size="sm">
        <b>Note on Data Identification:</b> Because we do not require account
        registration or email addresses, your data is linked only to your Player ID or
        IP Address. To exercise your rights regarding specific gameplay data, you must
        provide us with your assigned Player ID.
      </Text>
      <Text size="sm">
        To exercise any of these rights, please contact us at{' '}
        <a href="mailto:risto.paavola@gmail.com" style={{ color: 'var(--ink-text)' }}>risto.paavola@gmail.com</a>.
      </Text>
      <Text size="sm" fw={700}>Right to Lodge a Complaint</Text>
      <Text size="sm">
        If you believe that our processing of your personal data violates data
        protection laws, you have the right to lodge a complaint with a supervisory
        authority. In Finland, the competent authority is the Office of the Data
        Protection Ombudsman (Tietosuojavaltuutetun toimisto, tietosuoja.fi).
      </Text>

      <Title order={4} style={titleStyle}>7. Changes to This Privacy Policy</Title>
      <Text size="sm">
        We may update this Privacy Policy from time to time to reflect changes in
        legal requirements or operational practices. The updated version will be
        indicated by the "Last Updated" date at the top of this document.
      </Text>

      <Button onClick={onClose} style={primaryBtnStyle}>Got it</Button>
    </Stack>
  </Modal>
);

export default PrivacyPolicyModal;
