// Correo conocido de cada agente - mismos valores que KNOWN_EMAILS en
// public/index.html (usado ahi para precargar el campo al crear el acceso).
// Se usa para reconocer ventas del sheet cargadas con el correo del agente
// en la columna AGENTE en vez de su nombre.
export const AGENTE_EMAILS: Record<string, string> = {
  "Ana Sánchez": "92anasp@gmail.com",
  "Andry Camacho": "juliana1611sanchez@gmail.com",
  "Angela Galindez": "Angela.Galindez@hotmail.com",
  "Daniela Charry": "danielacharryp@gmail.com",
  "Diego Alejandro Mora": "diego150905ruiz@gmail.com",
  "Fernando Sandoval": "Sandovalandradefernando@gmail.com",
  "Gabriel Alejandro Monteverde": "Gabrielmonteverde75@gmail.com",
  "Henry Andrés Correa": "henryandrescorrea@hotmail.com",
  "Jhon Camacho": "nxjaca25@gmail.com",
  "Juan Ceballos": "Sebastianceballos0405@gmail.com",
  "Juanita Sánchez": "princesamagicajuanita@gmail.com",
  "Laura Charry": "laurasofia2297@gmail.com",
  "Luis Felipe Charry": "pipech2220@gmail.com",
  "Luis Gómez": "luis.andres162000@gmail.com",
  "Luna Sandoval": "Linitajovel@gmail.com",
  "María Paula Guevara": "mariapaulaguevaravalencia0@gmail.com",
  "Nicolás Correa": "Nacr1204@gmail.com",
  "Santiago Charry": "sentilli125@gmail.com",
  "Santiago Sandoval": "santiagosandovalandrade95@gmail.com",
  "Sergio Gallo": "vajumundial@gmail.com",
};

export const EMAIL_TO_AGENTE: Record<string, string> = Object.fromEntries(
  Object.entries(AGENTE_EMAILS).map(([nombre, email]) => [email.toLowerCase(), nombre])
);
