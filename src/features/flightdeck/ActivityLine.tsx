// The live "what it's doing now" line for a running agent. Mounted only while the
// card is in the running state, so the stream-scan derivation (useActivityLabel)
// runs only for active agents.
import { useActivityLabel } from "../../store/activity";
import { ConvMark } from "../conversation/ConvMark";
import { RollText } from "../../ui/RollText";

export function ActivityLine({ convId }: { convId: string }) {
  const text = useActivityLabel(convId);
  return (
    <div className="ag-card-act">
      <span className="wf-act run">
        <ConvMark session={convId} className="wf-spin" />
        <RollText text={text} className="wf-act-t" />
      </span>
    </div>
  );
}
