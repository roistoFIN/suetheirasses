import React, { useState, useEffect } from 'react';
import {
  Container,
  Paper,
  Title,
  Text,
  Button,
  Group,
  Stack,
  TextInput,
  NumberInput,
  Badge,
  Flex,
  Alert,
  Modal,
} from '@mantine/core';
import { useSocketStore } from '../stores/socketStore';
import { useGameStore } from '../stores/gameStore';
import { ClientEvents, type Lawsuit } from '@suetheirasses/shared';

const Resolution: React.FC = () => {
  const [responses, setResponses] = useState<Record<string, { defense: string; settlement?: number }>>({});
  const [pendingLawsuits, setPendingLawsuits] = useState<Lawsuit[]>([]);
  const [settlementModal, setSettlementModal] = useState<string | null>(null);
  const [settlementAmount, setSettlementAmount] = useState<number>(0);
  const { send } = useSocketStore();
  const { room, player, companies } = useGameStore();

  // Get lawsuits where the current player is the defendant and not yet resolved
  useEffect(() => {
    if (!player || !player.companyId) return;
    const plaintiffCompany = companies.get(player.companyId);
    if (!plaintiffCompany) return;
    const received = plaintiffCompany.lawsuitsReceived?.filter(
      (l: Lawsuit) => l.defendantId === player.id && !l.resolved,
    ) ?? [];
    setPendingLawsuits(received);
  }, [room, player, companies]);

  const handleDefenseChange = (lawsuitId: string, defense: string) => {
    setResponses((prev) => ({
      ...prev,
      [lawsuitId]: { ...prev[lawsuitId], defense },
    }));
  };



  const handleRespond = (lawsuitId: string) => {
    const response = responses[lawsuitId];
    if (!response?.defense) return;
    send(ClientEvents.LAWSUIT_RESPOND, {
      lawsuitId,
      defense: response.defense,
      settlementOffer: response.settlement,
    });
  };

  const handleSettle = (lawsuitId: string) => {
    if (!settlementAmount || settlementAmount <= 0) return;
    send(ClientEvents.LAWSUIT_RESPOND, {
      lawsuitId,
      defense: 'We wish to settle this matter.',
      settlementOffer: settlementAmount,
    });
    setSettlementModal(null);
  };

  const openSettlementModal = (lawsuit: Lawsuit) => {
    const suggestedAmount = Math.floor(Number(lawsuit.claimAmount) * 0.5);
    setSettlementAmount(suggestedAmount);
    setSettlementModal(lawsuit.id);
  };

  if (!room || !player) return null;

  return (
    <Container size="lg" py="xl">
      <Paper withBorder p="xl" shadow="lg">
        <Flex justify="space-between" align="center" mb="xl">
          <Title order={2}>🔨 Phase 5: Legal Resolution</Title>
          <Badge color="red" size="lg">
            Round {room.currentPhaseRound}
          </Badge>
        </Flex>

        <Alert variant="filled" color="red" mb="xl">
          Respond to lawsuits filed against you. Write a defense to potentially win, or offer a settlement to reduce the penalty.
        </Alert>

        <Stack>
          {pendingLawsuits.length === 0 ? (
            <Alert variant="filled" color="green">
              No pending lawsuits to respond to.
            </Alert>
          ) : (
            pendingLawsuits.map((lawsuit: Lawsuit) => (
              <Paper key={lawsuit.id} withBorder p="md">
                <Title order={4} mb="md">
                  {(() => {
                    const plaintiff = room?.players.find(p => p.id === lawsuit.plaintiffId);
                    return plaintiff?.name || 'Unknown';
                  })()} vs. You
                </Title>
                <Stack gap="md">
                  <Flex justify="space-between">
                    <Text>
                      <strong>Claim Amount:</strong> ${lawsuit.claimAmount}
                    </Text>
                    <Badge color="orange">Pending</Badge>
                  </Flex>
                  <Text>
                    <strong>Grounds:</strong> {lawsuit.grounds}
                  </Text>

                  <TextInput
                    label="Your Defense"
                    placeholder="Describe your defense (min 10 characters)..."
                    value={responses[lawsuit.id]?.defense || ''}
                    onChange={(e) => handleDefenseChange(lawsuit.id, e.target.value)}
                  />

                  <Group justify="space-between">
                    <Button
                      variant="outline"
                      onClick={() => openSettlementModal(lawsuit)}
                      disabled={!responses[lawsuit.id]?.defense}
                    >
                      Offer Settlement (50%: ${Math.floor(Number(lawsuit.claimAmount) * 0.5)})
                    </Button>
                    <Button
                      onClick={() => handleRespond(lawsuit.id)}
                      disabled={!responses[lawsuit.id]?.defense}
                    >
                      Submit Response
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            ))
          )}
        </Stack>
      </Paper>

      {/* Settlement Modal */}
      <Modal
        opened={!!settlementModal}
        onClose={() => setSettlementModal(null)}
        title="Offer Settlement"
      >
        <Stack>
          <Text>
            Offering a settlement reduces your penalty but still costs you money.
            The suggested amount is 50% of the claim.
          </Text>
          <NumberInput
            label="Settlement Amount ($)"
            value={settlementAmount}
            onChange={(value) => setSettlementAmount(Number(value))}
            min={1000}
            step={1000}
          />
          <Group justify="flex-end">
            <Button variant="outline" onClick={() => setSettlementModal(null)}>
              Cancel
            </Button>
            <Button onClick={() => settlementModal && handleSettle(settlementModal)}>
              Confirm Settlement
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Container>
  );
};

export default Resolution;
