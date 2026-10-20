'use strict';
// Topic catalog. Base tier = initial difficulty guess; adaptation may later override it (see adapt.js).
// One entry per concrete, familiar, drawable thing. No synonyms, no numbered/synthetic labels.
// Topic id = lowercase slug of the display name and is stable forever: never rename, only add or retire.
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

const EASY = list(`
apple, banana, pizza, cake, cookie, bread, cheese, carrot, cat, dog, fish, bird, cow, pig, duck, frog, snake,
house, tree, flower, sun, moon, star, cloud, rain, car, bus, boat, ball, hat, shoe, sock, book, chair, table, bed,
door, key, bell, egg, heart, smile,
orange, grapes, strawberry, cherry, lemon, pear, pineapple, watermelon, pumpkin, tomato, potato, corn, mushroom, onion,
broccoli, peach, coconut, sandwich, hamburger, hot dog, pie, donut, cupcake, lollipop, candy, pancake, waffle, pretzel,
spaghetti, taco, toast, french fries, honey, peanut, avocado, garlic, mango, plum, lime, marshmallow, muffin, bagel,
jellybean, bubblegum, popsicle, banana peel, apple core,
cup, plate, bowl, spoon, fork, knife, bottle, jar, teapot, pan, salt shaker,
sheep, chicken, bear, snail, ladybug, worm, ant, bone,
grass, leaf, rock, snow, snowflake, lightning, fire, ice cube, wave, hill, cave, acorn, pinecone, seashell, feather, branch,
log, raindrop, icicle, tulip, rose, daisy, nest, spider web,
eye, ear, nose, mouth, tooth, hand, foot, finger, arm, leg, face, hair, tongue, knee, footprint,
roof, stairs, fence, mailbox, chimney, bathtub, toilet, sink, mirror, pillow, blanket, couch, rug, curtain, shelf, basket,
bucket, broom, soap, towel, toothbrush, comb, lock, light bulb, birdhouse, doghouse, fishbowl,
shirt, pants, dress, jacket, mittens, boots, sandals, necktie, belt, shorts, button,
box, bag, ring, necklace, coin, flag, arrow, crayon, ruler, eraser, paper, pen, wheel, rope, paintbrush, stamp, bandage, hook,
circle, square, triangle, spiral,
doll, teddy bear, building block, yoyo, dice, swing, slide, bubble, wagon, tire, stop sign, baby, snowball,bean, pea pod,cereal box, milk carton, soda can, lunch bag,sleeping bag, tissue box, sticky note, paper plane, paper boat, paper cup, popcorn bucket, lemonade stand,straw, slippers, pacifier, crib, bib, rattle, lips, eyebrow, mustache, beard, bracelet, earring, headband, clover, sprout,flagpole, traffic cone, sausage, bacon, butter, lettuce, radish, olive, ketchup bottle, egg carton, cutting board, oven mitt, thumb, toe, elbow, neck,lamp post, bench, bookmark, mop, sponge, hairbrush, napkin, tray, dustpan, ornament, giraffe, zebra, fox, wolf, deer, parrot, swan, seal, donkey, lizard, goose, cucumber, celery, television, wallet, suitcase, globe, map, ribbon, notebook, shovel, rake, church, basketball, whistle, pond, lake, forest, king, queen, vase, skull
`);

const MEDIUM = list(`
popcorn, icecream, horse, turtle, rabbit, mouse, lion, tiger, elephant, monkey, penguin, owl, bee, spider, butterfly,
shark, whale, dolphin, octopus, crab, snowman, rainbow, mountain, volcano, island, river, beach, rocket, planet, train,
plane, bicycle, truck, tractor, lamp, clock, window, umbrella, glasses, scarf, backpack, guitar, piano, drum, camera,
phone, computer, pencil, scissors, hammer, ladder, tent, ghost, robot, dragon, pirate, crown, sword, shield, balloon,
candle, gift, kite, anchor, magnet, envelope, trophy,
hippo, rhino, crocodile, gorilla, camel, squirrel,moose, raccoon, skunk, bat,
hedgehog, panda, koala,flamingo, peacock,eagle, seagull, pelican, toucan, rooster,turkey, ostrich,
walrus, starfish, seahorse, lobster,dinosaur,llama, beaver, otter, mosquito, caterpillar,
dragonfly, grasshopper, scorpion, squid, eel, bull,sushi, sundae, cotton candy, gingerbread man, burrito, croissant, eggplant, bell pepper,cabbage, kiwi,
hot chocolate,
toaster, blender, microwave, refrigerator, oven, vacuum cleaner, washing machine, iron, coat hanger, bookshelf, bunk bed,
fireplace, doorbell, fan,remote control, radio, headphones, microphone, keyboard, calculator, printer,
battery, plug, flashlight,purse,briefcase, wristwatch, binoculars, magnifying glass,medal,
party hat, snow globe, picture frame, easel, paint palette, paint roller,stapler, paperclip,lunchbox, toothpaste, razor, hairdryer, lipstick, thermometer, crutches, wheelchair, first aid kit, sunflower,
saw, screwdriver, wrench, drill, axe,wheelbarrow, garden hose, lawnmower, pliers, tape measure, toolbox,
motorcycle, scooter, fire truck, police car, ambulance, dump truck, bulldozer, construction crane, sailboat, canoe,
cruise ship, hot air balloon, sled, snowboard, ice skate, roller skates, ferris wheel, carousel, taxi, school bus,
barn, treehouse, cabin,skyscraper, tunnel, gate,statue, playground, swimming pool, traffic light,
gas pump, campfire, sandcastle,hospital, fire station,football, tennis racket, golf club, hockey stick, bowling pin, dartboard, trampoline, fishing rod,
bow and arrow, boxing glove,skis, surfboard, kayak, diving board, jump rope, frisbee, boomerang, dumbbell,
chessboard, domino, deck of cards, baseball bat, soccer goal, volleyball net, ping pong paddle, bicycle helmet,
violin, flute, xylophone, tambourine, banjo, harmonica, ukulele,music note, conductor baton,
desert, palm tree, sunset, iceberg,comet, astronaut, satellite, alien, ufo, shooting star,
knight, witch, fairy, unicorn, zombie, mummy, santa claus, elf, clown, ninja, cowboy, firefighter, doctor, chef,
police officer, farmer,princess, superhero, angel,scuba diver, mailman, waiter, lifeguard,
christmas tree, stocking, reindeer, sleigh, wreath, jack o lantern, easter egg, candy cane, gingerbread house,
pirate ship, pirate flag,magic wand, top hat, cauldron, broomstick, crystal ball, wishing well,
picnic basket,beach ball, beach umbrella,lifebuoy, life jacket,
beehive, anthill, bird nest, dandelion, lily pad, venus flytrap,bamboo, cherry blossom,cowboy hat, bow tie, apron, flip flops, overalls, tutu, wetsuit, lab coat, raincoat, rain boots, winter hat, ski goggles,
brain,lungs, double helix, ribcage, wishbone,
microscope, test tube, beaker,solar panel, wind turbine, power lines, satellite dish, water tower, silo,
fire hydrant, parking meter, vending machine, cash register, treadmill, birdcage, lava lamp, disco ball, jukebox,
cuckoo clock, grandfather clock, rotary phone, cassette tape, floppy disk, movie camera, clapperboard, projector,
sewing machine, anvil, spinning top, pinwheel, wind chime, dreamcatcher, piggy bank,shopping cart, baby stroller,
baby bottle, rocking horse, rocking chair, high chair,bean bag,camp stove, thermos,
watering can, flower pot,bird bath, bird feeder, hamster, guinea pig, whisk, rolling pin, ladle, plunger, tricycle, newspaper
`);

const HARD = list(`
trumpet, helicopter, submarine, bridge, castle, lighthouse, wizard, treasure, skateboard, waterfall, windmill, telescope,
cactus, jellyfish, kangaroo, scarecrow, parachute, fireworks, tornado, bagpipes, chandelier, hourglass, compass, lantern,
fountain, pyramid, igloo, saxophone, unicycle, skeleton, vampire, mermaid, spaceship, rollercoaster, drawbridge, fossil,
harp, snorkel, avalanche,
chameleon, platypus, narwhal, armadillo, porcupine, axolotl, sloth, anteater, pangolin, aardvark, manatee, swordfish,
pufferfish, anglerfish, stingray, orca, hermit crab, vulture, woodpecker, hummingbird, roadrunner, stork, heron,
praying mantis, firefly, centipede, tarantula, beetle, moth, bison, yak, mongoose, meerkat, lemur, chimpanzee, orangutan,
tapir, okapi, hyena, cheetah, leopard, badger, opossum, pigeon, shrimp, oyster, clam,mountain goat,
polar bear,king cobra, komodo dragon, mandrill, capybara,
stethoscope, accordion, cello, periscope, sundial, abacus, catapult, typewriter, gramophone, metronome, sextant,
hammock, pogo stick, weathervane, trebuchet, tuba, trombone, clarinet, bugle, telephone booth, bunsen burner, spinning wheel,
scuba tank, diving helmet, ship wheel, totem pole, teepee, pagoda, eiffel tower, leaning tower, big ben, sphinx, stonehenge,
oil rig, dam, windsock, space suit, space shuttle, lunar rover, black hole, milky way, solar system, eclipse,
constellation, northern lights, galaxy, meteor, moon crater,
monorail, gondola, cable car, rickshaw, covered wagon, stagecoach, hang glider, blimp, biplane, jet ski, snowmobile,
forklift, tow truck, garbage truck, cement mixer, combine harvester, army tank, aircraft carrier, paddleboat, steam train,
tightrope walker, juggler, magician, mime, ballerina, mountain climber, lumberjack, detective, pharaoh, gladiator,
viking, samurai, caveman, spy, genie, gnome, cyclops, centaur, phoenix, minotaur, pegasus, yeti, werewolf, troll,
artichoke, pomegranate, cauliflower, dragon fruit, fondue, lasagna, kebab, baguette, wedding cake, bubble tea, chopsticks,
ramen, dumpling, fortune cookie, candy apple, corn dog, smores,tuxedo, kilt, kimono, sombrero, beret, suspenders, high heels, poncho, turban, snowshoes,hardhat, welding mask,
stalagmite, cliff, oasis, sand dune, coral reef, orchid, cattail,geyser, canyon, glacier,
bobsled, curling stone, balance beam, archery target, pool table, tombstone, coffin, haunted house,suit of armor, coat of arms, crossbow, battering ram, gargoyle, portcullis, moat,lunar lander,space station,radio tower,treasure map, message in a bottle,shipwreck,kraken, loch ness monster,hot spring, rope bridge,stone arch, spiral staircase, revolving door,
escalator, elevator, fire escape, water slide,lifeboat, harpoon, trident, fishing net,ice sculpture, snow angel,haystack,cave painting,carnival mask, puppet, marionette, ventriloquist dummy, jack in the box,
kaleidoscope,observatory, planetarium, aquarium, greenhouse, beehive frame, pterodactyl, triceratops, stegosaurus, tyrannosaurus, mammoth, dodo, puffin, albatross, cassowary, sea lion, jaguar, warthog, wildebeest, antelope, red panda, wombat, tasmanian devil, echidna, kookaburra, koi fish, clownfish, nautilus, sand dollar, sea urchin, barnacle, water buffalo, mole, ferret, bassoon, oboe, french horn, bongo drums, cymbals, music box, pipe organ,pocket watch, monocle, walking cane, bowler hat, fedora, spyglass, quill pen, inkwell, scroll, candelabra, gavel, scales of justice, joystick, game controller, drone, jetpack, food truck, ice cream truck, road roller, ski lift,dog sled, tugboat, ferry, speedboat, hovercraft, penny farthing, go kart, statue of liberty, mount rushmore, easter island head, colosseum, taj mahal, parthenon, sydney opera house, colander, cheese grater, corkscrew, can opener, fly swatter, feather duster, mousetrap, bear trap, rubiks cube, swiss army knife
`);

module.exports = { EASY, MEDIUM, HARD };
