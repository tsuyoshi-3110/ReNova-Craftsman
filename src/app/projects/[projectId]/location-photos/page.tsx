import LocationPhotosClient from "./LocationPhotosClient";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function Page({ params }: PageProps) {
  const { projectId } = await params;
  return <LocationPhotosClient initialProjectId={projectId} />;
}
