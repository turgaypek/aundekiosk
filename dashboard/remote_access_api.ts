export interface RemoteAccessApiOptions {
  // Reading a unit's status needs no elevated privilege — any local user
  // can query systemd over the system bus — so this never goes through
  // sudo/a privileged helper, same as service_control_api.ts's own
  // checkServiceStatus.
  checkServiceStatus: (service: string) => Promise<string>;
}

export function createRemoteAccessApi(opts: RemoteAccessApiOptions) {
  const { checkServiceStatus } = opts;

  async function handleStatus(): Promise<Response> {
    const [ssh, vnc] = await Promise.all([checkServiceStatus("ssh"), checkServiceStatus("wayvnc")]);
    return Response.json({ ssh, vnc });
  }

  return { handleStatus };
}
