import { createFileRoute } from "@tanstack/react-router";

import { CampaignWorkspace } from "../components/CampaignWorkspace";
import { SidebarInset } from "../components/ui/sidebar";

function CampaignRouteView() {
  const { campaignId } = Route.useParams();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <CampaignWorkspace campaignId={campaignId} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/campaigns/$campaignId/")({
  component: CampaignRouteView,
});
