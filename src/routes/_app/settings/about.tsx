import { createFileRoute } from '@tanstack/react-router';
import { AboutPanel } from '~components/settings/about-panel';
import { SectionHead } from '~components/settings/section-head';

export const Route = createFileRoute('/_app/settings/about')({
  component: AboutRoute,
});

function AboutRoute() {
  return (
    <>
      <SectionHead
        title="About"
        description="Source revision used to build this platform."
      />
      <AboutPanel />
    </>
  );
}
