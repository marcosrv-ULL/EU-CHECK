# Imagen base con Node.js LTS y herramientas comunes
FROM node:18-slim

# Crear directorio de trabajo
WORKDIR /app

# Copiar dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el resto del proyecto
COPY . .

# Exponer el puerto de desarrollo
EXPOSE 3000
EXPOSE 5173

# Comando por defecto: iniciar app React (dev server)
CMD ["npm", "run", "dev"]
