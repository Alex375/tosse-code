// The live "what it's doing now" line for a running agent. Mounted only while the
// card is in the running state, so the stream-scan derivation (useLiveActivity)
// runs only for active agents.
import { Ico } from "../../ui/kit";
import { useLiveActivity } from "../../store/activity";

export function ActivityLine({ convId }: { convId: string }) {
  const text = useLiveActivity(convId);
  return (
    <div className="ag-card-act">
      <span className="wf-act run">
        <Ico name="spark" className="sm wf-spin" />
        <span className="wf-act-t">{text}</span>
      </span>
    </div>
  );
}
