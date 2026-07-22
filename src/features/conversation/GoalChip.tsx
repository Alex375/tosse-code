// The conversation composer's active-`/goal` button: a small target chip that, on click, opens a
// popover with the full goal (Claude Code's native goal feature — Claude keeps working across turns
// until a completion condition holds). Goals are often long, so the condition lives in the popover
// (where it can wrap), NOT inline on the chip. Renders nothing when no goal is active. Goal state is
// read from the transcript (disk-only — never on the live stream); see `goalStore`. The popover body
// is shared verbatim with the Flight Deck card (see GoalPopover).

import { ChipBtn, Menu } from "../../ui/kit";
import { useActiveGoal } from "../../store/goalStore";
import { GoalPopover } from "./GoalPopover";

export function GoalChip({ convId }: { convId: string }) {
  const goal = useActiveGoal(convId);
  if (!goal) return null;
  return (
    <Menu
      up
      align="right"
      trigger={
        <ChipBtn
          icon="target"
          className="cv-goal-chip"
          aria-label="Active goal — open to view"
          title="Active goal"
        />
      }
    >
      <GoalPopover convId={convId} goal={goal} />
    </Menu>
  );
}
