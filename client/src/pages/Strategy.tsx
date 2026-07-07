import React, { useState } from 'react';
import {
  Container,
  Paper,
  Title,
  Text,
  Button,
  Group,
  Stack,
  Select,
  NumberInput,
  TextInput,
  Badge,
  Flex,
  Alert,
} from '@mantine/core';
import { useSocketStore } from '../stores/socketStore';
import { useGameStore } from '../stores/gameStore';
import { ClientEvents, StrategyActionType } from '@suetheirasses/shared';

const ACTION_OPTIONS = [
  { value: StrategyActionType.INVEST, label: '💰 Invest' },
  { value: StrategyActionType.EXPAND, label: '🏗️ Expand' },
  { value: StrategyActionType.LAYOFF, label: '👥 Layoffs' },
  { value: StrategyActionType.MERGER, label: '🤝 Merger' },
  { value: StrategyActionType.AD_CAMPAIGN, label: '📢 Ad Campaign' },
  { value: StrategyActionType.RESEARCH_AND_DEVELOPMENT, label: '🔬 R&D' },
  { value: StrategyActionType.OUTSOURCE, label: '🌍 Outsource' },
  { value: StrategyActionType.ACQUISITION, label: '🏢 Acquisition' },
];

const Strategy: React.FC = () => {
  const [actions, setActions] = useState<{ type: string; amount?: number; details?: string }[]>([
    { type: StrategyActionType.INVEST, amount: 10000 },
  ]);
  const { send } = useSocketStore();
  const { room, player, timer } = useGameStore();

  const addAction = () => {
    if (actions.length < 5) {
      setActions([...actions, { type: StrategyActionType.INVEST, amount: 10000 }]);
    }
  };

  const updateAction = (index: number, field: string, value: unknown) => {
    const newActions = [...actions];
    newActions[index] = { ...newActions[index], [field]: value };
    setActions(newActions);
  };

  const handleSubmit = () => {
    send(ClientEvents.STRATEGY_SUBMIT, { actions });
  };

  if (!room || !player) return null;

  return (
    <Container size="lg" py="xl">
      <Paper withBorder p="xl" shadow="lg">
        <Flex justify="space-between" align="center" mb="xl">
          <Title order={2}>📋 Phase 2: Strategic Choices</Title>
          <Badge color="blue" size="lg">
            Round {room.currentPhaseRound}
          </Badge>
        </Flex>

        <Stack>
          <Text c="dimmed">
            Choose up to 5 strategic actions for your company. Each action affects your cash flow.
          </Text>

          <Stack>
            {actions.map((action, index) => (
              <Paper key={index} withBorder p="md">
                <Flex gap="md" align="end" wrap="wrap">
                  <Select
                    label="Action"
                    value={action.type}
                    onChange={(value) => updateAction(index, 'type', value)}
                    options={ACTION_OPTIONS}
                    style={{ flex: 2, minWidth: 200 }}
                  />
                  <NumberInput
                    label="Amount ($)"
                    value={action.amount}
                    onChange={(value) => updateAction(index, 'amount', Number(value))}
                    min={0}
                    step={1000}
                    style={{ flex: 1, minWidth: 150 }}
                  />
                  <TextInput
                    label="Details"
                    value={action.details || ''}
                    onChange={(e) => updateAction(index, 'details', e.target.value)}
                    placeholder="Optional notes"
                    style={{ flex: 1, minWidth: 150 }}
                  />
                </Flex>
              </Paper>
            ))}
          </Stack>

          {actions.length < 5 && (
            <Button variant="outline" onClick={addAction}>
              + Add Action
            </Button>
          )}

          <Group justify="right" mt="lg">
            <Button size="lg" onClick={handleSubmit} disabled={timer <= 0}>
              Submit Strategies
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Container>
  );
};

export default Strategy;
