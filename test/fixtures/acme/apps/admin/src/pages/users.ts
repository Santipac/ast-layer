const logger = { info: (msg: string) => console.log("pages/users", msg) };

export async function getServerSideProps(context: { query: Record<string, string> }) {
  const page = Number(context.query.page ?? "1");
  logger.info("loading");
  if (Number.isNaN(page) || page < 1) {
    return { notFound: true };
  }
  return { props: { page } };
}
