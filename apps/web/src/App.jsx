import Layout from "./components/Layout";
import SplitPane from "./components/SplitPane";
import Chat from "./components/Chat";
import AvatarPanel from "./components/Avatarpanel";

const messages = [
  { id: 1, text: "¡Hola! Soy el avatar A.", isUser: false },
  { id: 2, text: "¡Buenas! Preparando el panel GenAI.", isUser: true },
  { id: 3, text: "Recuerda que podemos plegar el chat con la pestaña.", isUser: false },
  { id: 4, text: "Y también cambiar su ancho arrastrando.", isUser: true },
];

export default function App() {
  return (
    <Layout>
      <SplitPane
        initialWidth={360}
        minWidth={260}
        maxWidth={560}
        collapsedWidth={52}
        childrenLeft={
          <Chat
            onSend={async (text, messages) => {
              
              await new Promise(r => setTimeout(r, 400));
              return `Eco: ${text}`;
            }}
          />
        }
        childrenRight={
          <div className="grid h-full grid-cols-1 md:grid-cols-2 lg:grid-cols-3 auto-rows-[minmax(220px,1fr)] gap-4 place-items-center">
            <div className="col-span-full row-span-full w-full h-full">
              <AvatarPanel name="Modelo A" avatarUrl={"/avatars/av3.png"} />
            </div>
          </div>
        }
      />
    </Layout>
  );
}
