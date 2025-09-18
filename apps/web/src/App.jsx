import Layout from "./components/Layout";
import SplitPane from "./components/SplitPane";
import Chat from "./components/Chat";
import AvatarPanel from "./components/Avatarpanel";

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
              <AvatarPanel name="Taylor" psdUrl="/avatars/taylor.psd" />
            </div>
          </div>
        }
      />
    </Layout>
  );
}
