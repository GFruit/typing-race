import { server } from "./app.config";

const port = Number(process.env.PORT || 2567);

server.listen(port).then(() => {
  console.log(`Listening on ws://localhost:${port}`);
});
