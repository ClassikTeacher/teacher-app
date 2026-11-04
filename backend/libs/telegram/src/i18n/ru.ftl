# Russian locale (Fluent). All bot texts live here (10.7). Values are HTML (parse_mode=HTML);
# variables with user input are escaped before being passed in.

## Common
btn-yes = Да
btn-no = Нет
btn-done = Готово
btn-open-staff-bot = Перейти в рабочий бот
cancel-done = Диалог прерван.
cancel-nothing = Сейчас нет активного диалога.
callback-stale = Кнопка устарела, начните заново.
fallback-start-over = Я не понял сообщение. Начните заново: /start

## Errors (AppError codes)
error-internal = Что-то пошло не так. Попробуйте ещё раз чуть позже.
error-account-blocked = Доступ ограничен, обратитесь к администратору.
error-forbidden = У вас нет прав для этого действия.
error-not-found = Ничего не найдено.
error-validation-error = Проверьте введённые данные и попробуйте снова.
error-invitation-invalid = Приглашение недействительно, обратитесь к администратору.
error-invitation-not-for-you = Приглашение адресовано не вам.
error-conflict = Это действие уже выполнено.
error-feature-disabled = Эта функция отключена администратором.
error-limit-exceeded = Достигнут лимит, обратитесь к администратору.
error-rate-limited = Слишком много запросов, подождите немного.

## Roles
role-teacher = учитель
role-admin = администратор
role-bootstrap = суперадминистратор
role-super_admin = суперадминистратор
role-student = ученик
role-parent = родитель

## AuthBot
auth-help = Это служебный бот платформы: здесь принимают приглашения и проходят регистрацию. Рабочие функции — в рабочем боте.
auth-need-invite = Чтобы начать, откройте ссылку-приглашение от администратора.
auth-already-active = Вы уже зарегистрированы. Рабочие функции — в рабочем боте.
auth-resume-onboarding = Продолжим регистрацию с начала.
account-blocked = Доступ ограничен, обратитесь к администратору.
username-missing = У вашего аккаунта Telegram нет имени пользователя (username). Установите его в настройках Telegram — он понадобится для входа в веб-версию.
invite-invalid = Приглашение недействительно, обратитесь к администратору.
invite-expired = Срок приглашения истёк. Попросите администратора выпустить новое.
invite-used = Это приглашение уже использовано.
invite-revoked = Приглашение отозвано администратором.
invite-not-for-you = Приглашение адресовано не вам.
invite-add-role = Вам предлагают роль «{ $role }». Добавить её к вашему аккаунту?
invite-declined = Хорошо, роль не добавлена.
invite-role-added = Готово: роль «{ $role }» добавлена к вашему аккаунту.

## Onboarding questionnaire (5.1.2)
onb-name = <b>Регистрация, шаг 1.</b> Как вас зовут? Сейчас в Telegram: <b>{ $name }</b>.
    Напишите имя и фамилию или оставьте как есть.
btn-keep-name = Оставить: { $name }
onb-name-invalid = Напишите имя и фамилию текстом (до 60 символов).
onb-subjects = <b>Шаг 2.</b> Выберите предметы, которые вы ведёте. Выбрано: { $count }.
onb-subjects-required = Выберите хотя бы один предмет
onb-timezone = <b>Шаг 3.</b> Ваш часовой пояс (сейчас: { $current }). Выберите кнопкой или напишите зону, например <code>Europe/Minsk</code>.
onb-timezone-invalid = Не узнаю такой часовой пояс. Напишите в формате <code>Регион/Город</code>, например <code>Europe/Minsk</code>.
onb-duration = <b>Шаг 4.</b> Длительность занятия по умолчанию, минут (сейчас: { $current }). Выберите или напишите число.
onb-duration-invalid = Введите целое число минут от 15 до 480.
onb-notice = <b>Шаг 5.</b> Текст по умолчанию для отмен и переносов. Он будет отправляться ученикам, если вы ничего не напишете. Рекомендуем написать свой.

    Сейчас: <i>{ $current }</i>
btn-keep-notice = Оставить этот текст
onb-notice-invalid = Напишите текст до { $max } символов.
onb-consent = <b>Последний шаг.</b> Продолжая, вы принимаете условия использования и политику обработки персональных данных (версия { $version }).
btn-accept-consent = Принимаю
onb-consent-button = Чтобы продолжить, нажмите кнопку «Принимаю».
onb-done = <b>Готово!</b> Регистрация завершена. Переходите в рабочий бот.

## StaffBot (4.4)
btn-back = ◀️ Назад
btn-open-auth-bot = Открыть служебный бот
staff-need-invite = Этот бот доступен учителям и администраторам платформы. Чтобы получить доступ, примите приглашение в служебном боте.
staff-finish-onboarding = Сначала завершите регистрацию в служебном боте.
staff-not-staff = Этот бот предназначен для учителей и администраторов.
staff-help = Рабочий бот: ученики, группы, занятия, материалы, задания, журналы и настройки. Меню — /menu.
staff-main-menu = <b>Главное меню</b> · { $roles }
staff-admin-menu = <b>Администрирование</b>
staff-section-soon = Раздел «{ $section }» появится в следующих версиях.
menu-today = 📅 Сегодня / Неделя
menu-lesson = ➕ Занятие
menu-students = 👥 Ученики
menu-groups = 🧑‍🤝‍🧑 Группы
menu-materials = 📚 Материалы
menu-assignments = 📝 Задания
menu-journals = 📊 Журналы и отчёты
menu-attention = ⚠️ Требует внимания
menu-settings = ⚙️ Настройки
menu-admin-section = 🛠 Администрирование
menu-teachers = 👩‍🏫 Учителя
menu-users = 🔎 Пользователи
menu-features = 🎚 Фичи и лимиты
menu-invitations = ✉️ Приглашения
menu-subjects = 📖 Предметы
menu-filetypes = 📎 Типы файлов
menu-audit = 🧾 Аудит
menu-admins = 👑 Администраторы

## Errors, continued (one key per ERROR_CODE; checked by core/i18n.test.ts)
error-unauthorized = Нужно войти заново.
error-lesson-conflict = В это время уже есть занятие.
error-lesson-started = Занятие уже началось: напишите учителю.
error-outside-availability = Это время вне окон учителя.
error-weekly-limit-exceeded = На этой неделе у вас уже максимум занятий у этого учителя.
error-slot-requests-full = На это время уже есть заявки, выберите другое.
error-storage-quota-exceeded = Хранилище учителя заполнено, напишите учителю.
error-upload-rate-limit = Слишком много файлов за час, попробуйте позже.
error-cancel-reason-required = Укажите причину отмены.
error-cancel-cutoff = Отменить так поздно нельзя: напишите учителю напрямую.
error-cancel-disabled = Учитель отключил отмену занятий: напишите ему напрямую.
error-link-not-active = Вы больше не занимаетесь у этого учителя.
error-parent-consent-required = Нужно согласие родителя.
error-file-type-not-allowed = Этот формат файла не принимается.
error-file-too-large = Файл слишком большой.
error-file-rejected = Файл не прошёл антивирусную проверку и отклонён.
username-required = Для работы в платформе нужен username в Telegram. Установите его в настройках Telegram и снова нажмите «Принимаю».

## Admin section (M1-06)
btn-cancel = Отмена
btn-invite-teacher = ✉️ Пригласить учителя
btn-features = 🎚 Фичи и лимиты
btn-block = ⛔ Заблокировать
btn-unblock = ✅ Разблокировать
btn-grant-admin = 👑 Сделать админом
btn-revoke-admin = 👑 Снять роль админа
btn-no-name = Без имени
btn-open-invite-link = Открыть ссылку-приглашение
btn-revoke-invite = Отозвать приглашение
btn-lessons-cancel = Отменить будущие занятия с сообщением
btn-lessons-keep = Оставить занятия (временная блокировка)
btn-confirm-block = Заблокировать
btn-search-again = 🔎 Искать ещё
flow-text-expected = Ответьте текстом.
flow-media-expected = Жду файл или фото. Чтобы прервать — /cancel.
text-too-long = Текст должен быть не длиннее { $max } символов.
card-status = Статус
card-roles = Роли
card-timezone = Часовой пояс
card-block-reason = Причина блокировки
status-invited = приглашён
status-onboarding = регистрация не завершена
status-active = активен
status-blocked = заблокирован
teachers-list = <b>Учителя</b> · всего { $total }
invite-teacher-name = Как подписать приглашение? Напишите имя будущего учителя или нажмите «Без имени».
invite-teacher-name-invalid = Имя не длиннее { $max } символов.
invite-teacher-noname = без имени
invite-teacher-card = <b>Приглашение на платформу</b>
    Для: { $name }
    Ссылка действует до { $expires } и работает один раз.

    Перешлите это сообщение будущему учителю — ссылка откроет служебный бот:
    { $link }
invite-until = до
invite-revoked-ok = Приглашение отозвано
invitations-title = <b>Ожидающие приглашения</b>
invitations-empty = Пока нет ожидающих приглашений.
block-reason = Блокировка: { $name }. Напишите причину (её увидят только администраторы).
block-policy = Что сделать с будущими занятиями?
block-policy-cancel = отменить будущие занятия с сообщением
block-policy-keep = оставить занятия (временная блокировка)
block-policy-none = занятий нет
block-message = Напишите сообщение, которое получат участники отменённых занятий.
block-confirm = <b>Подтвердите блокировку</b>
    Кого: { $name }
    Причина: { $reason }
    Занятия: { $policy }
block-done = Аккаунт { $name } заблокирован.
features-global = <b>Фичи платформы</b> · { $on } включена для всех, { $off } выключена на платформе. Нажмите, чтобы переключить.
features-teacher = <b>Фичи и лимиты: { $name }</b>
    { $on } включена · { $off } выключена · ✎ личная настройка (↺ сбросить) · ⛓ выключена зависимостью · 🔒 выключена на платформе. Нажмите, чтобы переключить или изменить лимит.
feature-stage = этап { $stage }
feature-core = Платформа
feature-calendar-open-booking = Открытый календарь
feature-calendar-google = Google Calendar
feature-calendar-ics = ICS-подписка
feature-groups = Группы
feature-groups-telegram = Telegram-группы классов
feature-storage = Файловое хранилище
feature-materials = Материалы и подборки
feature-homework = Домашние задания
feature-homework-submissions = Сдача файлов через бота
feature-journal-school = Школьные отметки
feature-journal-tests = Журнал тестов
feature-journal-custom = Кастомный журнал
feature-reports = Отчёты успеваемости
feature-parents-cc = Копии родителям
feature-invite-group-link = Групповые ссылки и QR
feature-bulk-cancel = Массовая отмена
feature-broadcasts = Объявления
feature-web = Веб-интерфейс
feature-miniapp = Mini App
limit-maxStudents = Макс. учеников
limit-maxGroups = Макс. групп
limit-quotaBytes = Квота хранилища
limit-maxFileBytes = Макс. размер файла
limit-none = без лимита
limit-enter = Введите значение для «{ $limit }» { $unit } или выберите «без лимита».
limit-invalid = Введите целое число.
limit-saved = Лимит сохранён.
unit-mb = МБ
admins-list = <b>Администраторы</b> · { $total }. Нажмите, чтобы снять роль. Назначить админом можно из карточки учителя.
admin-granted = Роль администратора выдана
admin-revoked = Роль администратора снята
users-search-prompt = Поиск пользователя: напишите имя, фамилию или username.
users-search-invalid = Запрос — от 2 до 60 символов.
users-search-results = Найдено: { $count }
users-search-empty = Никого не найдено.

## Notifications (5.13.1), rendered by the worker: `ntf-<type with . and _ → ->`
ntf-admin-teacher-onboarded = 👩‍🏫 Учитель <b>{ $name }</b>{ $handle } подключился к платформе.
ntf-admin-invitation-expired = ⌛ Срок приглашения истёк: { $name }. При необходимости выпустите новое.
ntf-feature-changed = { $enabled ->
    [on] ✅ Вам доступна функция «{ $feature }».
   *[other] ⛔ Функция «{ $feature }» отключена администратором.
  }
ntf-role-granted = 👑 Вам выдана роль администратора. Раздел «Администрирование» появился в меню.
ntf-account-unblocked = ✅ Доступ к платформе восстановлен.

## Catalogues (M1-08)
btn-add-subject = ➕ Добавить предмет
subjects-list = <b>Предметы</b> · { $total }. 🟢 доступен учителям, ⚪️ скрыт. Нажмите, чтобы переключить.
subject-add-prompt = Напишите название нового предмета.
subject-added = Предмет «{ $name }» добавлен в справочник.
subject-exists = Предмет «{ $name }» уже есть в справочнике.
filetypes-list = <b>Допустимые типы файлов</b> · 🟢 принимается, ⚪️ не принимается. Нажмите, чтобы переключить.

## Super admin transfer (UC-02)
btn-sat-confirm = ✅ Принять роль
btn-sat-decline = ❌ Отклонить
sat-pending = Вам предложена роль суперадминистратора платформы. Принять?
sat-confirmed = Готово: теперь вы суперадминистратор платформы.
sat-declined = Передача роли отклонена.
ntf-security-sa-transfer-requested = 🔐 Запрошена передача роли суперадминистратора от { $from }. Нажмите кнопку ниже, чтобы принять или отклонить. Ссылка действует 24 часа.
ntf-security-sa-transfer-confirmed = 🔐 Роль суперадминистратора передана: { $from } → { $to }.
ntf-security-sa-transfer-declined = 🔐 { $to } отклонил(а) передачу роли суперадминистратора.
ntf-security-sa-transfer-cancelled = 🔐 Передача роли суперадминистратора ({ $from } → { $to }) отменена.

## StudentBot and ParentBot (M2-01, 4.4)
btn-skip = Пропустить
btn-open-menu = Открыть меню
btn-open-student-bot = Открыть бот ученика
btn-open-parent-bot = Открыть бот родителя
btn-accept-invite = ✅ Принять
btn-decline-invite = ❌ Отклонить
btn-confirm-parent = ✅ Да, я родитель
btn-write-teacher = ✉️ Написать учителю
person-section-soon = Раздел «{ $section }» появится в следующих версиях.
invite-wrong-bot-auth = Это приглашение для учителя или администратора: откройте его в служебном боте.
invite-wrong-bot-student = Это приглашение для ученика: откройте его в боте ученика.
invite-wrong-bot-parent = Это приглашение для родителя: откройте его в боте родителя.
invite-wrong-bot-staff = Это приглашение для учителя или администратора: откройте его в служебном боте.

student-help = Бот ученика: расписание, задания, материалы, успеваемость, ваши учителя и родители. Меню — /menu.
student-need-invite = Чтобы начать, откройте ссылку-приглашение от учителя.
student-not-student = Этот бот предназначен для учеников. Попросите учителя прислать вам приглашение.
student-main-menu = <b>Главное меню</b> · { $name }
student-invite-card = <b>{ $teacher }</b> ({ $subjects }) приглашает вас заниматься.
    Принять приглашение?
student-invite-declined = Хорошо, приглашение отклонено. Учитель узнает об этом.
student-already-linked = Вы уже занимаетесь у { $teacher }.
student-teachers-list = <b>Мои учителя</b>
student-teachers-empty = <b>Мои учителя</b>
    Пока нет активных учителей.
student-teacher-card = <b>{ $teacher }</b>
    Предметы: { $subjects }
    Лимит занятий в неделю: { $limit }
smenu-schedule = 📅 Расписание
smenu-booking = ➕ Записаться
smenu-assignments = 📝 Задания
smenu-materials = 📚 Материалы
smenu-progress = 📊 Успеваемость
smenu-cancel = ❌ Отменить занятие
smenu-teachers = 👩‍🏫 Мои учителя
smenu-parents = 👨‍👩‍👧 Родители
smenu-archive = 🗂 Архив
smenu-settings = ⚙️ Настройки
sonb-name = <b>Регистрация, шаг 1.</b> Как вас зовут? Сейчас в Telegram: <b>{ $name }</b>.
    Напишите имя и фамилию или оставьте как есть.
sonb-grade = <b>Шаг 2.</b> В каком вы классе? Напишите, например, <code>9</code> или <code>11А</code>, или пропустите. Сейчас: { $current }.
sonb-timezone = <b>Шаг 3.</b> Ваш часовой пояс (сейчас: { $current }). Выберите кнопкой или напишите зону, например <code>Europe/Minsk</code>.
sonb-consent = <b>Последний шаг.</b> Продолжая, вы принимаете условия использования и политику обработки персональных данных (версия { $version }).
sonb-done = <b>Готово!</b> Вы занимаетесь у { $teacher }. Учитель получил уведомление.

parent-help = Бот родителя: дети, их расписание, задания, успеваемость, учителя и запросы согласия. Меню — /menu.
parent-need-invite = Чтобы начать, откройте ссылку-приглашение от учителя вашего ребёнка.
parent-not-parent = Этот бот предназначен для родителей. Попросите учителя прислать вам приглашение.
parent-main-menu = <b>Главное меню</b> · { $name }
parent-invite-card = Учитель <b>{ $teacher }</b> приглашает вас как родителя (законного представителя) ученика <b>{ $child }</b>.
    Нажимая «Да, я родитель», вы подтверждаете, что являетесь законным представителем ученика, и принимаете условия использования и политику обработки персональных данных (версия { $version }) — за себя и за ребёнка.
parent-invite-is-student = Это приглашение адресовано родителю. Передайте ссылку родителю.
parent-invite-declined = Хорошо. Ссылка остаётся действительной, если передумаете.
parent-already-linked = Вы уже привязаны к ученику { $child }.
parent-limit-reached = У ученика { $child } уже четыре родителя — больше привязать нельзя. Обратитесь к учителю.
parent-children-list = <b>Дети</b> · выбран: { $child }. Нажмите, чтобы переключить.
parent-children-empty = <b>Дети</b>
    Пока нет привязанных детей.
pmenu-children = 👧 Дети
pmenu-schedule = 📅 Расписание ребёнка
pmenu-assignments = 📝 Задания ребёнка
pmenu-progress = 📊 Успеваемость и отчёты
pmenu-teachers = 👩‍🏫 Учителя ребёнка
pmenu-requests = ✅ Запросы
pmenu-settings = ⚙️ Настройки
ponb-name = <b>Регистрация, шаг 1.</b> Как вас зовут? Сейчас в Telegram: <b>{ $name }</b>.
    Напишите имя и фамилию или оставьте как есть.
ponb-timezone = <b>Шаг 2.</b> Ваш часовой пояс (сейчас: { $current }). Выберите кнопкой или напишите зону, например <code>Europe/Minsk</code>.
ponb-consent = <b>Последний шаг.</b> Продолжая, вы принимаете условия использования и политику обработки персональных данных (версия { $version }) — за себя и как законный представитель ученика <b>{ $child }</b>.
ponb-done = <b>Готово!</b> Вы привязаны к ученику { $child }. Ученик и учитель получили уведомления.

## Students section of StaffBot (M2-02, UC-10)
btn-invite-parent = 👨‍👩‍👧 Пригласить родителя
btn-create-lesson = ➕ Поставить занятие
ntf-link-student-joined = 🎉 <b>{ $name }</b> присоединился(ась) к вам ({ $subjects }). Пригласите родителя или поставьте первое занятие.
ntf-link-declined = 🙁 Приглашение отклонено: { $name }.
btn-add-student = ➕ Добавить ученика
btn-pending-students = ⏳ Ожидают ({ $count })
btn-archive-students = 🗂 Архив ({ $count })
btn-reissue-invite = 🔁 Перевыпустить ссылку
btn-to-students = 👥 К ученикам
students-list = <b>Ученики</b> · { $total }
students-empty = <b>Ученики</b>
    Пока нет учеников. Нажмите «Добавить ученика», чтобы получить персональную ссылку-приглашение.
students-pending = <b>Ожидают принятия</b> · нажмите, чтобы открыть карточку
students-pending-empty = <b>Ожидают принятия</b>
    Нет карточек, ожидающих принятия.
students-archive = <b>Архив</b> · ученики, занятия с которыми завершены
students-archive-empty = <b>Архив</b>
    Архив пуст.
students-parents-soon = Приглашение родителей появится в следующей версии.
pending-state-waiting = ждёт принятия до { $until }
pending-state-expired = ссылка истекла
pending-state-revoked = ссылка отозвана
pending-state-declined = отклонил(а)
link-status-active = занимается с { $since }
link-status-ended = завершено { $on }
end-reason-removed-by-teacher = учитель завершил занятия
end-reason-left-by-student = ученик ушёл
end-reason-ended-by-parent = родитель завершил занятия
end-reason-system = по решению администрации
card-end-reason = Причина
card-grade = Класс
card-school = Школа
card-subjects = Предметы
card-weekly-limit = Лимит занятий в неделю
card-goals = Цели
card-notes = Заметки
invite-student-subjects = <b>Новый ученик, шаг 1.</b> Выберите предмет (можно несколько). Выбрано: { $count }.
invite-student-limit = <b>Шаг 2.</b> Сколько занятий в неделю может записать себе ученик? По умолчанию { $default }. Выберите или напишите число.
invite-student-limit-invalid = Введите целое число от 1 до { $max } или выберите «без лимита».
invite-student-name = <b>Шаг 3.</b> Как подписать карточку? Напишите имя ученика или пропустите — имя подтянется из Telegram.
invite-student-grade = <b>Шаг 4.</b> Класс ученика (необязательно), например <code>9</code>.
invite-student-card = <b>Приглашение на занятия</b>
    { $teacher } приглашает вас заниматься.
    { $forLine }Предмет: { $subjects }
    { $limitLine }
    Ссылка действует до { $expires } и работает один раз.

    Перешлите это сообщение ученику — ссылка откроет бот ученика:
    { $link }
invite-student-for = Для: { $name }
    { "" }
invite-student-limit-line = Лимит занятий в неделю: { $limit }
invite-student-no-limit = Без лимита занятий в неделю
student-invite-revoked-ok = Приглашение отозвано

## Parents in the student card, StudentBot and ParentBot (M2-03, UC-11)
btn-parents = 👨‍👩‍👧 Родители
btn-unlink-parent = 🔗✖️ Отвязать: { $name }
btn-revoke-parent-link = 🗑 Ссылка до { $until }
btn-unlink-child = 🔗✖️ Отвязаться от ребёнка
btn-confirm-unlink = Да, отвязаться
parents-title = <b>Родители ученика { $student }</b>
parents-empty = Родителей пока нет. Пригласите родителя — он получит копии сообщений и сможет подтверждать уход ученика.
parent-invited-elsewhere = приглашён другим учителем
parent-link-pending = ссылка для родителя ждёт принятия до { $until }
parent-unlinked-ok = Связь с родителем отозвана
invite-parent-card = <b>Приглашение для родителя</b>
    Ученик: { $student }
    Ссылка действует до { $expires } и работает один раз.

    Перешлите это сообщение родителю — ссылка откроет бот родителя:
    { $link }
student-parents-title = <b>Родители</b>
student-parents-empty = К вашему профилю пока не привязаны родители.
student-parents-note = Родителей приглашает и отвязывает учитель.
parent-teachers-list = <b>Учителя: { $child }</b>
parent-teachers-empty = <b>Учителя: { $child }</b>
    Пока нет активных учителей.
parent-teacher-card = <b>{ $teacher }</b> · ученик { $child }
    Предметы: { $subjects }
parent-unlink-confirm = Отвязаться от ученика { $child }? Вы перестанете получать копии сообщений и видеть его расписание. Учитель и ученик получат уведомление.
ntf-family-parent-linked = 👨‍👩‍👧 К вашему профилю привязан родитель: <b>{ $parent }</b>.
ntf-family-parent-connected = 👨‍👩‍👧 Родитель <b>{ $parent }</b> подключён к ученику { $child }.
ntf-family-parent-unlinked = { $view ->
    [parent] 🔗✖️ Вы отвязаны от ученика { $child } ({ $byText }).
    [teacher] 🔗✖️ Родитель <b>{ $parent }</b> отвязан от ученика { $child } ({ $byText }).
   *[student] 🔗✖️ Родитель <b>{ $parent }</b> больше не привязан к вашему профилю ({ $byText }).
  }
family-by-parent = по решению родителя
family-by-teacher = по решению учителя
family-by-admin = по решению администратора
parent-unlink-teacher-confirm = Отвязать родителя { $parent } от ученика { $student }? Родитель перестанет получать копии и видеть расписание ученика; все получат уведомление.
parent-already-revoked = Связь уже отозвана

## Student card editing and teacher settings (M2-04)
btn-clear-field = Очистить
btn-edit-alias = ✏️ Псевдоним
btn-edit-grade = ✏️ Класс
btn-edit-school = ✏️ Школа
btn-edit-subjects = 📖 Предметы
btn-edit-limit = 🔢 Лимит в неделю
btn-edit-goals = 🎯 Цели
btn-edit-notes = 📝 Заметки
btn-calendar-default = 📅 Календарь: как у всех
btn-calendar-open = 📅 Календарь: открыт
btn-calendar-closed = 📅 Календарь: закрыт
btn-end-link = ⛔ Завершить занятия
students-end-soon = Завершение занятий с учеником появится в следующей версии.
card-saved = Сохранено.
card-edit-alias = Как подписать ученика у себя? Напишите псевдоним (до 60 символов) — его видите только вы.
card-edit-grade = В каком классе ученик? Напишите, например, <code>9</code> или <code>11А</code>.
card-edit-school = Школа ученика (до 120 символов).
card-edit-goals = Цели занятий, например «ЦТ по математике — 85+» (до 500 символов).
card-edit-notes = Личные заметки об ученике (до 2000 символов). Ученик их не видит.
card-edit-limit = Сколько занятий в неделю может записать себе ученик? Напишите число или выберите «без лимита».
card-subjects-screen = <b>Предметы: { $student }</b>. Нажмите, чтобы добавить или убрать; по новому предмету заводятся журналы.
btn-set-name = 👤 Имя
btn-set-timezone = 🕒 Часовой пояс
btn-set-subjects = 📖 Предметы
btn-set-duration = ⏱ Длительность
btn-set-buffers = ↔️ Буферы
btn-set-cancel = ❌ Отмены учениками
btn-set-notice = 💬 Текст по умолчанию
btn-set-templates = 📋 Шаблоны причин
btn-set-windows = 🗓 Окна и календарь
btn-set-notifications = 🔔 Уведомления и копии
btn-buffer-before = До занятия: { $n } мин
btn-buffer-after = После занятия: { $n } мин
btn-student-cancel = { $state } Ученик может отменять
btn-parent-cancel = { $state } Родитель может отменять
btn-cutoff = ⏳ Срок отмены учеником
btn-late-hours = 🕰 Поздняя отмена, ч
btn-add-template = ➕ Добавить шаблон
btn-no-cutoff = До начала занятия
on = включено
off = выключено
hours = { $n } ч
cutoff-until-start = до начала занятия
settings-summary = <b>Настройки</b>
    { $name } · { $username } · { $timezone }
    Предметы: { $subjects }
    Длительность занятия: { $duration } мин · буферы: { $before } / { $after } мин
    Отмена учеником: { $studentCancel } (не позднее чем за { $cutoff }) · родителем: { $parentCancel }
    Поздняя отмена: за { $late } ч
    Текст по умолчанию: <i>{ $notice }</i>
settings-subjects = <b>Мои предметы</b>. Нажмите, чтобы добавить или убрать (хотя бы один должен остаться).
settings-buffers = <b>Буферы между занятиями</b> — время, которое считается занятым до и после каждого занятия.
settings-cancel = <b>Отмены учениками и родителями</b> (Р-2, Р-25). Переключите разрешения или задайте сроки.
settings-soon = Этот раздел настроек появится в следующих версиях.
setting-saved = Сохранено.
setting-integer-invalid = Введите целое число от { $min } до { $max }.
setting-edit-name = Напишите имя и фамилию.
setting-edit-timezone = Напишите часовой пояс в формате <code>Регион/Город</code>, например <code>Europe/Minsk</code>.
setting-edit-defaultDurationMin = Длительность занятия по умолчанию, минут (от 15 до 480).
setting-edit-bufferBeforeMin = Буфер до занятия, минут (0–120).
setting-edit-bufferAfterMin = Буфер после занятия, минут (0–120).
setting-edit-lateCancelHours = За сколько часов отмена считается поздней (0–336)?
setting-edit-studentCancelCutoffHours = За сколько часов до начала ученик ещё может отменить занятие (0–336)? Или выберите «До начала занятия».
setting-edit-defaultNoticeText = Текст по умолчанию для отмен и переносов (до 500 символов).
setting-edit-template = Напишите текст шаблона причины (до 500 символов).
templates-title = <b>Шаблоны причин</b> · используются при отменах и переносах
templates-empty = Шаблонов пока нет.
card-edit-empty = Напишите текст или нажмите «Очистить».

## Groups (M2-05, UC-12)
btn-add-group = ➕ Создать группу
btn-group-members = 👥 Состав
btn-archive-group = 🗂 В архив
btn-confirm-archive = Да, в архив
groups-list = <b>Группы</b> · { $total }
groups-empty = <b>Группы</b>
    Групп пока нет. Создайте группу, чтобы ставить групповые занятия и выдавать задания сразу всем.
group-new-name = <b>Новая группа, шаг 1.</b> Как назвать группу? Например, «10А физика».
group-new-subject = <b>Шаг 2.</b> Предмет группы (можно пропустить).
group-new-emoji = <b>Шаг 3.</b> Эмодзи для группы — один символ (можно пропустить).
group-emoji-invalid = Нужен один эмодзи.
group-new-duration = <b>Шаг 4.</b> Длительность занятия группы по умолчанию, минут (или пропустите — будет как у вас в настройках).
group-created = Группа «{ $name }» создана. Добавьте участников.
group-card = <b>{ $emoji } { $name }</b>
    Предмет: { $subject } · длительность: { $duration }
    Участников: { $count }
    { $members }
group-no-members = Участников пока нет.
group-duration-default = как в настройках
group-members = <b>Состав: { $name }</b> · { $count }. ➖ убрать из группы, ➕ добавить ученика. Изменения касаются только будущих занятий.
group-archive-confirm = Отправить группу «{ $name }» в архив? Участники ({ $count }) будут исключены, будущие групповые занятия обработает расписание.

## Ending links and leave requests (M2-06, 5.8, UC-33…35)
group-name-taken = Группа «{ $name }» уже есть. Напишите другое название.
btn-confirm-end-link = Завершить занятия
btn-leave-approve = ✅ Согласен(на)
btn-leave-decline = ❌ Не согласен(на)
end-link-message = <b>Завершение занятий с { $student }.</b> Напишите сообщение ученику и родителям или выберите шаблон. Оно обязательно.
end-link-confirm = <b>Подтвердите завершение занятий</b>
    Ученик: { $student }
    Сообщение: <i>{ $message }</i>
    Последствия: ученик выйдет из групп — { $groups }; будущие занятия — { $lessons }; родителей получат уведомление — { $parents }. История останется в архиве.
end-link-lessons-later = будут отменены (расписание появится в следующей версии)
end-link-done = Занятия с { $student } завершены. Ученик и родители получили уведомление.
ntf-link-ended = { $view ->
    [student] ⛔ Занятия с учителем <b>{ $teacher }</b> завершены ({ $reason }). Сообщение: <i>{ $message }</i>. История доступна в разделе «Архив».
    [parent] ⛔ Занятия { $student } с учителем <b>{ $teacher }</b> завершены ({ $reason }). Сообщение: <i>{ $message }</i>
   *[teacher] ⛔ Занятия с учеником <b>{ $student }</b> завершены ({ $reason }). Сообщение: <i>{ $message }</i>. Карточка перенесена в архив.
  }
ntf-link-leave-request = ❓ <b>{ $student }</b> хочет прекратить занятия у учителя <b>{ $teacher }</b>. Причина: <i>{ $reason }</i>. Согласны? Решение одного родителя достаточно; без ответа запрос закроется через 7 дней.
ntf-link-leave-reminder = ⏰ Напоминание: <b>{ $student }</b> ждёт вашего решения о прекращении занятий у <b>{ $teacher }</b>. Причина: <i>{ $reason }</i>.
ntf-link-leave-decided = { $view ->
    [parent] { $decision ->
        [approved] ✅ { $parent } согласился(ась): занятия { $student } у { $teacher } завершены.
       *[declined] ❌ { $parent } не согласился(ась) с уходом { $student } от { $teacher }. { $comment }
      }
   *[student] { $decision ->
        [approved] ✅ Родитель согласен: занятия у { $teacher } завершены. История — в «Архиве».
       *[declined] ❌ Родитель не согласен с прекращением занятий у { $teacher }. { $comment }
      }
  }
ntf-link-leave-expired = ⌛ Родители не ответили за 7 дней — запрос о прекращении занятий закрыт. Вы можете отправить его снова.
btn-leave-teacher = ⛔ Прекратить занятия
btn-leave-send = Отправить родителям
btn-leave-confirm = Да, прекратить
leave-reason = <b>Прекращение занятий у { $teacher }.</b> Напишите причину — её увидят учитель и родители.
leave-confirm-direct = Вы уверены? Занятия у { $teacher } завершатся сразу, будущие занятия отменятся. История останется в «Архиве».
leave-confirm-consent = У вас есть родитель на платформе: запрос уйдёт ему. Пока он не ответит, занятия у { $teacher } идут как обычно. Учитель узнает только о решении.
leave-done = Занятия у { $teacher } завершены. История — в «Архиве».
leave-requested = Запрос отправлен родителям. Они могут ответить в течение 7 дней.
student-archive-list = <b>Архив</b> · учителя, занятия с которыми завершены. История доступна только для чтения.
student-archive-empty = <b>Архив</b>
    Пока пусто.
student-archive-card = <b>{ $teacher }</b>
    Предметы: { $subjects }
    Статус: { $state }
    Периоды: { $history }
student-archive-teacher-blocked = доступ учителя ограничен администрацией
parent-requests-title = <b>Запросы согласия</b>
parent-requests-empty = Открытых запросов нет.
parent-request-line = { $n }. <b>{ $student }</b> хочет прекратить занятия у <b>{ $teacher }</b>. Причина: <i>{ $reason }</i>
parent-request-approved = Вы согласились: занятия завершены. Учитель и ученик получили уведомление.
parent-request-declined = Вы не согласились: ученик получил ваше решение, занятия продолжаются.
parent-request-already-decided = Этот запрос уже закрыт.
parent-end-message = <b>Завершение занятий { $child } у { $teacher }.</b> Напишите сообщение учителю и ученику — оно обязательно.
parent-end-confirm = Завершить занятия { $child } у { $teacher }? Сообщение: <i>{ $message }</i>. Будущие занятия отменятся.
parent-end-done = Занятия { $child } у { $teacher } завершены. Учитель и ученик получили уведомление.

## Schedule: day views and personal blocks (M3-01, 5.5.2, 5.5.7)
btn-day-today = Сегодня
btn-day-tomorrow = Завтра
btn-day-week = Неделя
btn-add-block = 🚫 Занят
btn-remove-block = 🗑 Снять блок { $time }
btn-minutes = { $n } мин
schedule-day = <b>{ $day }</b>
    { $items }
schedule-day-empty = Пока ничего не запланировано.
schedule-week = <b>Неделя { $from } – { $to }</b>
    { $items }
schedule-week-day-empty = —
block-line = 🚫 { $from }–{ $to } { $title }
block-new-day = <b>Личный блок «занят», шаг 1.</b> На какой день? Выберите или напишите дату, например <code>25.10</code>.
block-new-start = <b>Шаг 2.</b> { $day }: с какого времени? Напишите, например <code>14:00</code>.
block-new-end = <b>Шаг 3.</b> С { $start } до какого времени? Напишите, например <code>16:00</code>, или выберите длительность.
block-new-title = <b>Шаг 4.</b> Подпись блока (необязательно), например «врач».
block-created = Блок «занят» { $day } { $from }–{ $to } { $title } создан. Это время не будет предлагаться ученикам.
block-removed = Блок снят
block-conflict = В это время у вас уже есть занятие или блок. Укажите другое время.
day-invalid = Не понял дату. Напишите в формате <code>ДД.ММ</code>, например <code>25.10</code>.
time-invalid = Не понял время. Напишите в формате <code>ЧЧ:ММ</code>, например <code>16:30</code>.
time-end-before-start = Время окончания должно быть позже начала.
time-nonexistent = В этот день такого времени нет из-за перевода часов. Укажите другое время.
block-in-past = Это время уже прошло. Выберите другой день или время.
btn-prev-day = ◀️
btn-next-day = ▶️

## Lessons (M3-02, UC-14, 5.6)
btn-lesson-card = 📄 Карточка занятия
btn-repeat-next-week = 🔁 Повторить через неделю
btn-create-with-minutes = ✅ Создать · { $n } мин
lesson-no-participants = без участников
lesson-outside-mark = · вне окна
lesson-outside-note = ⚠️ Занятие вне ваших окон (ученикам это время не предлагается).
lesson-title = Занятие
lesson-title-numbered = Занятие №{ $n }
lesson-status-scheduled = запланировано
lesson-status-awaiting-report = ждёт итогов
lesson-status-completed = проведено
lesson-status-not-held = не состоялось
lesson-status-cancelled = отменено
lesson-card-who = Кто
lesson-card-subject = Предмет
lesson-card-participants = Участники
lesson-card-planned-topic = Планируемая тема
lesson-card-topic = Тема
lesson-card-not-held-reason = Причина
lesson-card-comment = Комментарий ученику
lesson-card-notes = Заметки
lesson-format-online = Онлайн
lesson-format-in-person = Очно
lesson-format-at-student = У ученика
lesson-new-target = <b>Новое занятие, шаг 1.</b> С кем? Недавние — сверху.
lesson-new-no-targets = Пока некого ставить в расписание: добавьте ученика или создайте группу.
lesson-new-day = <b>Шаг 2.</b> { $who }: на какой день? Выберите или напишите дату, например <code>25.10</code>.
lesson-new-time = <b>Шаг 3.</b> { $who }, { $day }: во сколько? Свободные слоты (на { $duration } мин) ниже, или напишите время, например <code>16:30</code>.
lesson-new-time-no-slots = <b>Шаг 3.</b> { $who }, { $day }: свободных слотов на { $duration } мин с учётом занятости нет. Напишите время, например <code>16:30</code>, или выберите другой день.
lesson-new-duration = <b>Шаг 4.</b> { $day } { $time }: длительность. Нажмите «Создать» или выберите другую.
lesson-created = Занятие создано: { $who }, { $day } { $time }. Ученики получат уведомление.
lesson-created-outside = Занятие создано: { $who }, { $day } { $time }. ⚠️ Время вне ваших окон — ученикам оно не предлагается, но занятие стоит. Ученики получат уведомление.
lesson-conflict-teacher = У вас в это время занятие или блок. Выберите другое время.
lesson-conflict-student = У ученика в это время другое занятие. Выберите другое время.
lesson-conflict-race = Это время только что заняли. Выберите другое.
lesson-repeated = Повторено: { $who }, { $day } { $time }.
lesson-repeat-impossible = Повторить нельзя: ученик больше не занимается у вас или группа в архиве.
lesson-target-gone = Занятие не создано: ученик больше не занимается у вас, группа в архиве или в ней нет участников.
ntf-lesson-created = { $view ->
    [booked] 📅 Записался ученик: <b>{ $student }</b>, <b>{ $when }</b> ({ $duration } мин), { $subject }. Занятие уже в расписании.
   *[other] 📅 Назначено занятие: <b>{ $when }</b> ({ $duration } мин), { $subject }. Учитель: { $teacher }.
}
ntf-lesson-participants-changed = 📅 Вы добавлены в групповое занятие: <b>{ $when }</b> ({ $duration } мин), { $subject }. Учитель: { $teacher }.
ntf-lesson-reminder = ⏰ Напоминание: занятие <b>{ $when }</b> ({ $subject }){ $withWhom }.
ntf-lesson-member-conflicts = ⚠️ { $student } добавлен(а) в группу, но не попал(а) в занятия: { $dates } — в это время у ученика другие занятия.

## Availability windows and the calendar mode (M3-03, 5.5.4, 5.5.5)
btn-next = Далее
btn-add-rule = ➕ Окно по дням
btn-close-day = 🚫 Закрыть день
btn-extra-window = ➕ Разовое окно
btn-whole-day = Весь день
btn-weekdays-workdays = Пн–Пт
btn-calendar-mode-closed = 📅 Календарь: закрыт
btn-calendar-mode-open-all = 📅 Календарь: открыт всем
btn-calendar-mode-open-selected = 📅 Календарь: выбранным
calendar-mode-closed = закрыт для записи
calendar-mode-open-all = открыт для всех учеников
calendar-mode-open-selected = открыт для выбранных учеников (отмечены в карточках)
weekday-mon = пн
weekday-tue = вт
weekday-wed = ср
weekday-thu = чт
weekday-fri = пт
weekday-sat = сб
weekday-sun = вс
windows-screen = <b>Окна и календарь</b>
    Окна — время, когда ученики могут записываться (для вас это не ограничение, CAL-09).
    Еженедельно:
    { $rules }
    Исключения (ближайшие 90 дней):
    { $exceptions }
    Режим записи: { $mode }
windows-none = — окон нет, ученикам нечего предложить.
windows-no-exceptions = — нет.
rule-new-days = <b>Новое окно, шаг 1.</b> Выберите дни недели (выбрано: { $count }) и нажмите «Далее».
rule-days-required = Выберите хотя бы один день
rule-new-start = <b>Шаг 2.</b> С какого времени? Например <code>15:00</code>.
rule-new-end = <b>Шаг 3.</b> С { $start } до какого времени? Например <code>20:00</code>.
rule-created = Окно добавлено.
exception-new-day-closed = <b>Закрыть день, шаг 1.</b> Какой день? Выберите или напишите дату, например <code>25.10</code>.
exception-new-day-extra = <b>Разовое окно, шаг 1.</b> Какой день? Выберите или напишите дату, например <code>25.10</code>.
exception-new-start-closed = <b>Шаг 2.</b> { $day }: закрыть весь день или напишите, с какого времени закрыть, например <code>15:00</code>.
exception-new-start-extra = <b>Шаг 2.</b> { $day }: с какого времени открыть? Например <code>10:00</code>.
exception-created-closed = { $day }: время закрыто для записи. Уже поставленные занятия остаются.
exception-created-extra = { $day }: разовое окно добавлено.
validity-open-ended = …
exception-in-past = Эта дата уже прошла.

## Series (M3-04, UC-15, UC-39, 5.5.6)
ntf-series-conflicts = { $ended ->
    [yes] 🔁 Серия завершена: ученик больше не занимается у вас или группа недоступна. Создано занятий: { $created }.
   *[no] 🔁 Серия продлена: создано занятий — { $created }. Не удалось поставить (время занято): { $dates }. Перенесите или пропустите эти занятия.
  }
btn-make-regular = 🔁 Сделать регулярным
btn-series = 📆 Серии
btn-series-card = 📆 К серии
btn-no-end = Без конца
btn-pause-series = ⏸ Пауза
btn-resume-series = ▶️ Снять паузу
btn-end-series = ⏹ Завершить серию
btn-confirm-end-series = Да, завершить
series-new-days = <b>Регулярное занятие.</b> { $who }, { $time }, { $duration } мин. Выберите дни недели и нажмите «Далее».
series-new-end = <b>Дата окончания.</b> Серия начнётся { $start }. Напишите дату окончания, например <code>30.05</code>, или выберите «Без конца».
series-created = Серия создана: { $who }. Занятий поставлено на ближайшие 12 недель: { $created }. Горизонт продлевается автоматически.
series-created-conflicts = Серия создана: { $who }. Занятий поставлено: { $created }. Не удалось поставить (время занято): { $conflicts }. Перенесите или пропустите их.
series-list = <b>Серии</b> · регулярные занятия
series-empty = <b>Серии</b>
    Регулярных занятий пока нет. Откройте карточку занятия и нажмите «Сделать регулярным».
series-line = { $who } · { $days } { $time } · { $duration } мин{ $paused }
series-paused-mark = { " " }· пауза { $from }–{ $to }
series-card = <b>Серия: { $who }</b>
    Дни: { $days } · { $time } · { $duration } мин
    С { $from } { $until }
    Запланировано занятий: { $count }{ $paused }
series-until = до { $date }
series-until-open = без даты окончания
series-pause-from = <b>Пауза серии, шаг 1.</b> С какого дня? Напишите дату, например <code>01.11</code>.
series-pause-to = <b>Шаг 2.</b> По какой день включительно? Напишите дату, например <code>08.11</code>.
series-paused = Пауза с { $from } по { $to }: новые занятия в этот период не создаются, уже поставленные отменит расписание (появится в следующей версии).
series-resumed = Пауза снята, занятия поставлены до горизонта.
series-end-confirm = Завершить серию { $who }? Будущие занятия серии ({ $count }) отменит расписание (появится в следующей версии). Прошедшие останутся.
series-ended = Серия завершена.

## Lesson reports (M3-05, UC-24, UC-38, LES-06…08)
btn-topic-as-planned = ✅ Тема как планировали
btn-enter-topic = ✏️ Ввести тему
btn-student-no-show = 🚫 Ученик не пришёл
btn-report-later = ⏰ Позже
btn-lesson-report = 📝 Итоги
btn-attendance-present = ✅ Был(а)
btn-attendance-late = ⏱ Опоздал(а)
btn-attendance-absent-notified = ⚠️ Не был(а), предупредил(а)
btn-attendance-absent = ❌ Не был(а) без предупреждения
btn-no-show-reason = Неявка
attendance-present = присутствовал(а)
attendance-late = опоздал(а)
attendance-absent-notified = отсутствовал(а), предупредил(а)
attendance-absent = отсутствовал(а) без предупреждения
ntf-lesson-report-required = 📝 Как прошло занятие с <b>{ $who }</b> ({ $when })? Заполните итоги: тема и посещаемость.
ntf-lesson-summary = 📘 <b>Итоги занятия</b> { $when }, { $subject } (учитель { $teacher })
    Тема: { $topic }
    Посещаемость: { $attendance ->
        [late] опоздал(а)
        [absent_notified] отсутствовал(а), предупредил(а)
        [absent] отсутствовал(а)
       *[present] присутствовал(а)
      }
    { $comment }
ntf-series-created = 📆 Регулярные занятия: <b>{ $days } { $time }</b> ({ $duration } мин), { $subject }. Учитель: { $teacher }. Напоминания придут перед каждым занятием.
report-topic = <b>Итоги: { $who }, { $when }.</b> Какая была тема? Напишите или выберите.
report-attendance = <b>Посещаемость.</b> { $who }: выберите.
report-attendance-group = <b>Посещаемость.</b> Отметьте каждого участника и нажмите «Сохранить».
report-comment = <b>Комментарий ученику</b> (необязательно) — уйдёт в «Итоги занятия». Напишите или пропустите.
report-saved = Итоги сохранены: занятие проведено, ученики получат «Итоги занятия».
report-no-show-reason = <b>Занятие не состоялось.</b> Укажите причину (ученики её не увидят) или выберите «Неявка».
report-not-held-saved = Отмечено: занятие не состоялось.
report-later = Хорошо, напомню позже. Занятие ждёт итогов в разделе «Требует внимания».
report-not-over = Занятие ещё не закончилось.
report-already = Итоги уже заполнены.
report-participants-changed = Состав занятия изменился. Откройте карточку и заполните итоги заново.
attention-list = <b>Требует внимания</b> · занятия без итогов
attention-empty = <b>Требует внимания</b>
    Всё заполнено: занятий без итогов нет.

## Schedule in StudentBot and ParentBot (M3-06, 5.5.3, 5.5.7)
btn-lesson-cancel-soon = ❌ Отменить
btn-lesson-reschedule-soon = 🔁 Перенести
person-schedule-list = <b>Расписание</b> · ближайшие { $days } дней
    { $items }
person-schedule-empty = <b>Расписание</b>
    На ближайшие { $days } дней занятий нет.
person-schedule-past = 🕘 Прошедшие занятия
person-schedule-past-list = <b>Прошедшие занятия</b> · последние { $days } дней
    { $items }
person-schedule-past-empty = <b>Прошедшие занятия</b>
    За последние { $days } дней занятий не было.
person-lesson-line = { $mark } { $day } { $time } · { $teacher }{ $subject }
person-lesson-card = <b>{ $title }</b> · { $status }
    { $day } { $time } ({ $duration } мин)
    Учитель: { $teacher }
    Предмет: { $subject }
    { $details }
person-lesson-topic = Тема: { $topic }
person-lesson-comment = Комментарий: { $comment }
person-lesson-format = { $format }
person-lesson-actions-soon = Отмена и перенос появятся в следующей версии: пока напишите учителю.
parent-schedule-child = <b>Расписание: { $child }</b> · ближайшие { $days } дней
    { $items }
parent-schedule-child-empty = <b>Расписание: { $child }</b>
    На ближайшие { $days } дней занятий нет.
parent-schedule-no-child = Сначала привяжитесь к ребёнку: учитель пришлёт ссылку.

## Cancellations (M4-01, UC-20, UC-21, 5.7)
ntf-lesson-cancelled = { $view ->
    [by-teacher] ❌ Учитель { $teacher } отменил(а) занятие <b>{ $when }</b>{ $subject }. Причина: <i>{ $message }</i>
    [by-student] ❌ <b>{ $by }</b> отменил(а) занятие <b>{ $when }</b>. Причина: <i>{ $message }</i>{ $lateMark }
    [by-student-to-parent] ❌ <b>{ $by }</b> отменил(а) занятие у учителя { $teacher } <b>{ $when }</b>. Причина: <i>{ $message }</i>{ $lateMark }
    [by-parent] ❌ Родитель <b>{ $by }</b> отменил(а) занятие ученика { $child } <b>{ $when }</b>. Причина: <i>{ $message }</i>{ $lateMark }
   *[to-student] ❌ Занятие <b>{ $when }</b> отменено родителем ({ $by }). Причина: <i>{ $message }</i>
}
ntf-lesson-absence = { $view ->
    [by-parent] 🙋 Родитель <b>{ $by }</b> предупредил(а): { $student } не будет на групповом занятии <b>{ $when }</b>. Причина: <i>{ $message }</i>{ $lateMark }
    [to-student] 🙋 Родитель ({ $by }) сообщил(а) учителю, что вас не будет на занятии <b>{ $when }</b>. Причина: <i>{ $message }</i>
   *[by-student] 🙋 <b>{ $student }</b> предупредил(а), что не будет на групповом занятии <b>{ $when }</b>. Причина: <i>{ $message }</i>{ $lateMark }
}
ntf-late-mark = {" "}⚠️ Поздняя отмена.
btn-lesson-cancel = ❌ Отменить
btn-lesson-absence = 🙋 Не смогу прийти
btn-cancel-send-default = ✉️ Отправить текст по умолчанию
btn-cancel-own-text = ✍️ Свой текст
btn-cancel-confirm = ✅ Подтвердить
btn-cancel-back = ◀️ К занятию
cancel-reason-prompt = <b>Отмена занятия</b> · { $when }
    Выберите причину или напишите свою:
cancel-reason-prompt-teacher = <b>Отмена занятия</b> · { $when } · { $who }
    Текст по умолчанию: <i>{ $default }</i>
    Отправьте его, выберите шаблон или напишите свой текст:
absence-reason-prompt = <b>Отсутствие на групповом занятии</b> · { $when }
    Занятие остаётся в силе, учитель узнает, что вас не будет. Выберите причину или напишите свою:
cancel-own-text-prompt = Напишите причину (до { $max } символов):
cancel-confirm = <b>Отменить занятие?</b>
    { $when } · { $who }
    Причина: <i>{ $message }</i>
    { $late }
absence-confirm = <b>Сообщить об отсутствии?</b>
    { $when } · { $who }
    Причина: <i>{ $message }</i>
    { $late }
cancel-late-note = ⚠️ Поздняя отмена: до начала меньше { $hours } ч.
cancel-lesson-done = Занятие { $when } отменено. Остальные участники получат сообщение.
absence-done = Учитель предупреждён, что вас не будет на занятии { $when }.
cancel-not-possible = { $code ->
    [cancel-disabled] Учитель отключил отмену занятий через бота.
    [cancel-cutoff] Отменить можно не позже чем за { $hours } ч до начала.
    [lesson-started] Занятие уже идёт.
    [link-not-active] Вы больше не занимаетесь у этого учителя.
   *[conflict] Занятие уже отменено или завершено.
}
cancel-write-teacher-hint = Напишите учителю напрямую.
lesson-card-cancel-reason = Причина отмены: { $reason }
lesson-card-absent = Предупредили об отсутствии: { $names }

## Bulk cancellation (M4-02, UC-22, UC-23, 5.7.5)
ntf-cancellation-bulk = { $view ->
    [by-teacher] ❌ Учитель { $teacher } отменил(а) { $cancelledCount ->
        [one] { $cancelledCount } занятие
        [few] { $cancelledCount } занятия
       *[other] { $cancelledCount } занятий
    }: <b>{ $cancelled }</b>. Причина: <i>{ $message }</i>
    [by-student] ❌ <b>{ $by }</b>{ $cancelledCount ->
        [0] {""}
       *[other] {" "}отменил(а) занятия: <b>{ $cancelled }</b>
    }{ $absenceCount ->
        [0] {""}
       *[other] {" "}предупредил(а) об отсутствии на групповых занятиях: <b>{ $absences }</b>
    }. Причина: <i>{ $message }</i>{ $lateMark }
    [by-student-to-parent] ❌ <b>{ $by }</b> отменил(а) занятия у учителя { $teacher }: <b>{ $cancelled }{ $absences }</b>. Причина: <i>{ $message }</i>{ $lateMark }
    [by-parent] ❌ Родитель <b>{ $by }</b> за ученика { $child }{ $cancelledCount ->
        [0] {""}
       *[other] {" "}отменил(а) занятия: <b>{ $cancelled }</b>
    }{ $absenceCount ->
        [0] {""}
       *[other] {" "}предупредил(а) об отсутствии на групповых занятиях: <b>{ $absences }</b>
    }. Причина: <i>{ $message }</i>{ $lateMark }
    [system-to-student] ❌ Отменены занятия у учителя { $teacher }: <b>{ $cancelled }</b>. { $cause }: <i>{ $message }</i>
    [system-to-teacher] ❌ Отменены занятия с { $student }: <b>{ $cancelled }</b>. { $cause }: <i>{ $message }</i>
   *[to-student] ❌ Родитель ({ $by }) отменил(а) ваши занятия у учителя { $teacher }: <b>{ $cancelled }{ $absences }</b>. Причина: <i>{ $message }</i>
}
ntf-cancel-cause = { $source ->
    [link-ended] Занятия завершены
    [account-blocked] Решение администратора
    [series-paused] Пауза регулярных занятий
    [series-ended] Регулярные занятия завершены
    [series-changed] Регулярные занятия изменены
   *[other] Причина
}
ntf-group-lessons-left = { $reason ->
    [group-archived] 📂 Группа <b>{ $group }</b> расформирована: занятия { $dates } больше не ваши.
    [link-ended] 📂 Занятия с учителем завершены, занятия группы <b>{ $group }</b> { $dates } больше не ваши.
    [account-blocked] 📂 Занятия группы <b>{ $group }</b> { $dates } больше не ваши.
   *[other] 📂 Вы исключены из группы <b>{ $group }</b>: занятия { $dates } больше не ваши.
}
btn-cancel-many = ❌ Отменить несколько
btn-bulk-mode-pick = ☑️ Выбрать из списка
btn-bulk-mode-period = 📆 За период
btn-bulk-mode-target = 👤 Ученик или группа за период
btn-bulk-mode-teacher = 👩‍🏫 У одного учителя за период
btn-bulk-today = Сегодня
btn-bulk-tomorrow = Завтра
btn-bulk-week = 7 дней
btn-bulk-two-weeks = 14 дней
btn-bulk-custom = Ввести даты
btn-bulk-continue = Далее ➡️
btn-bulk-close-windows-on = ☑️ Закрыть окна на период
btn-bulk-close-windows-off = ⬜ Закрыть окна на период
btn-bulk-confirm = ✅ Отменить ({ $count })
bulk-mode-prompt = <b>Массовая отмена</b>
    Что отменяем?
bulk-period-prompt = За какой период?
bulk-custom-prompt = Введите даты через дефис, например <code>20.10-26.10</code> (не больше { $max } дней):
bulk-custom-invalid = Не понял даты. Формат: <code>20.10-26.10</code>.
bulk-target-prompt = С кем?
bulk-teacher-prompt = У какого учителя?
bulk-pick-prompt = <b>Отметьте занятия</b> (ближайшие { $days } дней), затем «Далее»:
bulk-pick-empty = На ближайшие { $days } дней занятий нет.
bulk-preview = <b>Предпросмотр</b> · { $count ->
        [one] { $count } занятие
        [few] { $count } занятия
       *[other] { $count } занятий
    }{ $late ->
        [0] {""}
       *[other] , поздних: { $late }
    }
    { $items }
    { $excluded }
bulk-preview-excluded = Исключены (отменить нельзя): { $items }
bulk-preview-absence-note = Групповые занятия станут сообщениями об отсутствии.
bulk-preview-empty = За выбранный период отменять нечего.
bulk-reason-prompt = Причина для всего пакета — выберите шаблон или напишите свою:
bulk-confirm = <b>Отменить { $count ->
        [one] { $count } занятие
        [few] { $count } занятия
       *[other] { $count } занятий
    }?</b>
    Причина: <i>{ $message }</i>
    { $windows }
bulk-confirm-windows = Окна на этот период будут закрыты.
bulk-done = Отменено: { $count }. Каждый получатель получит одно сводное сообщение.{ $windows ->
        [0] {""}
       *[other] {" "}Закрыто дней: { $windows }.
    }
bulk-done-empty = Ничего не отменено: к моменту подтверждения занятий не осталось.
bulk-excluded-code = { $code ->
    [cancel-disabled] учитель отключил отмену
    [cancel-cutoff] поздно отменять
    [lesson-started] уже идёт
    [already-reported] об отсутствии уже сообщено
    [not-participant] вы больше не участник
   *[conflict] уже отменено или завершено
}
bulk-preview-more = …и ещё { $count }

## Reschedule (M4-03, UC-18, UC-19, 5.7.4)
ntf-lesson-rescheduled = 🔁 Учитель { $teacher } перенёс(ла) занятие{ $subject }: <s>{ $from }</s> → <b>{ $to }</b>. { $comment }
ntf-lesson-reschedule-objection = { $view ->
    [by-parent] ⚠️ Родитель { $by } за ученика <b>{ $student }</b> не может в новое время занятия <b>{ $when }</b>. Причина: <i>{ $reason }</i>
   *[by-student] ⚠️ <b>{ $student }</b> не может в новое время занятия <b>{ $when }</b>. Причина: <i>{ $reason }</i>
}
ntf-booking-requested = { $view ->
    [reschedule] 🔁 <b>{ $student }</b>{ $by } просит перенести занятие на <b>{ $when }</b>. Причина: <i>{ $comment }</i>
    [reschedule_ask] 🔁 <b>{ $student }</b>{ $by } просит перенести занятие. Причина: <i>{ $comment }</i>. Откройте карточку и выберите новое время.
   *[booking] 📝 Заявка на занятие от <b>{ $student }</b>{ $by }: <b>{ $when }</b>. { $comment }
}
ntf-booking-decided = { $view ->
    [accepted] { $kind ->
        [booking] ✅ Учитель { $teacher } подтвердил(а) заявку: занятие <b>{ $when }</b> назначено. { $message }
       *[other] ✅ Учитель { $teacher } подтвердил(а) перенос: занятие теперь <b>{ $when }</b>. { $message }
    }
    [acknowledged] 👌 Учитель { $teacher } получил(а) вашу просьбу о переносе и ответит переносом занятия или сообщением. { $message }
    [declined] { $kind ->
        [booking] ❌ Учитель { $teacher } отклонил(а) заявку на <b>{ $when }</b>. { $message }
        [reschedule] ❌ Учитель { $teacher } отклонил(а) запрос на перенос на { $when }. { $message }
       *[other] ❌ Учитель { $teacher } отклонил(а) просьбу о переносе. { $message }
    }
    [weekly_limit] ❌ Учитель { $teacher } не подтвердил(а) заявку на <b>{ $when }</b>: на этой неделе у вас уже максимум занятий. { $message }
    [slot_taken] ⛔ Слот <b>{ $when }</b> уже занят{ $kind ->
        [booking] {""}
       *[other] , перенос не удался
    }. Свободные слоты: { $slots }
    [expired] ⌛ Запрос на <b>{ $when }</b> истёк: учитель не ответил вовремя. Выберите другое время.
    [link_ended] ℹ️ Заявка закрыта: занятия у учителя { $teacher } завершены.
    [account_blocked] ℹ️ Заявка закрыта по решению администратора.
   *[lesson_changed] ℹ️ Учитель изменил занятие, ваш запрос на перенос закрыт.
}
ntf-by-parent = родитель
ntf-no-open-slots = открытых слотов пока нет
btn-move-ok = 👌 ОК
btn-move-cannot = 🙅 Не могу в это время
btn-request-accept = ✅ Подтвердить
btn-request-decline = ❌ Отклонить
btn-lesson-move = 🔁 Перенести
btn-move-no-comment = Без комментария (текст по умолчанию)
btn-requests = 📨 Заявки
move-day-prompt = <b>Перенос занятия</b> { $when } · { $who }
    На какой день?
move-time-prompt = { $day }: новое время (длительность { $duration } мин). Свободные слоты или введите своё:
move-time-no-slots = { $day }: свободных слотов нет, введите время вручную (ЧЧ:ММ):
move-comment-prompt = Комментарий для участников (необязательно):
move-confirm = <b>Перенести занятие?</b>
    { $who }: <s>{ $from }</s> → <b>{ $to }</b>
    Сообщение: <i>{ $comment }</i>
btn-move-confirm = ✅ Перенести
move-done = Занятие перенесено на { $to }. Участники получат уведомление.
move-conflict = Это время занято{ $who ->
    [teacher] : у вас другое занятие или блок
    [student] : у ученика другое занятие
   *[other] {""}
}. Выберите другое.
move-same-time = Занятие уже стоит на это время.
move-objection-prompt = Почему не подходит новое время? Напишите учителю:
move-objection-done = Учитель получит ваше сообщение. Занятие пока остаётся на новом времени.
move-ack-done = Хорошо, до встречи на занятии!
request-day-prompt = <b>Запрос на перенос</b> { $when } · { $teacher }
    Учитель подтвердит перенос; до его ответа занятие остаётся. На какой день?
request-slot-prompt = { $day }: выберите открытый слот:
request-slot-none = { $day }: открытых слотов нет. Выберите другой день.
request-reason-prompt = Причина переноса (обязательна):
request-confirm = <b>Отправить запрос?</b>
    { $teacher }: <s>{ $from }</s> → <b>{ $to }</b>
    Причина: <i>{ $reason }</i>
btn-request-send = 📨 Отправить
request-sent = Запрос отправлен. Учитель подтвердит или отклонит перенос; до ответа занятие { $from } в силе.
ask-reason-prompt = <b>Просьба о переносе</b> { $when } · { $teacher }
    Календарь учителя закрыт для записи, поэтому время выберет учитель. Напишите причину:
ask-sent = Просьба отправлена учителю. Занятие { $when } пока в силе.
request-pending-exists = По этому занятию уже есть запрос: дождитесь ответа учителя.
requests-list = <b>Заявки</b> · ожидают ответа: { $count }
    { $items }
requests-empty = <b>Заявки</b>
    Открытых заявок нет.
request-line = { $kind ->
    [reschedule] 🔁 { $student }: { $lessonWhen } → { $when }
    [reschedule_ask] 🔁 { $student }: просьба о переносе { $lessonWhen }
   *[booking] 📝 { $student }: { $when }
}
request-card = { $kind ->
    [reschedule] <b>Запрос на перенос</b>
        { $student }: <s>{ $lessonWhen }</s> → <b>{ $when }</b>
        Причина: <i>{ $comment }</i>
    [reschedule_ask] <b>Просьба о переносе</b>
        { $student }: занятие { $lessonWhen }
        Причина: <i>{ $comment }</i>
        Перенесите занятие из его карточки — просьба закроется сама.
   *[booking] <b>Заявка на занятие</b>
        { $student }: <b>{ $when }</b>
        { $comment }
}
request-decline-prompt = Сообщение ученику (обязательно):
request-accepted = Перенос подтверждён: занятие теперь { $when }.
request-acknowledged = Просьба закрыта, ученик получит ответ. Перенесите занятие из его карточки.
request-declined = Заявка отклонена, ученик получит сообщение.
request-slot-taken = Слот уже занят: заявка отклонена, ученику ушли открытые слоты.
request-gone = Заявка уже закрыта.
btn-request-close = Закрыть просьбу

## Open calendar and booking (M4-04, UC-16, UC-17, 5.5.5)
book-teacher-prompt = <b>Записаться на занятие</b>
    К кому?
book-no-open-teachers = Ни один из ваших учителей пока не открыл календарь для записи.
book-day-prompt = { $teacher }: на какой день?
book-slot-prompt = { $day }: открытые слоты ({ $duration } мин):
book-slot-none = { $day }: открытых слотов нет. Выберите другой день.
book-duration-prompt = Длительность занятия:
book-comment-prompt = Комментарий учителю (необязательно):
btn-book-no-comment = Без комментария
book-confirm = <b>Записаться?</b>
    { $teacher }: <b>{ $when }</b> ({ $duration } мин)
    { $note }
book-confirm-manual-note = Учитель подтвердит заявку; до ответа время не занято.
btn-book-confirm = ✅ Записаться
book-done-lesson = Готово: занятие <b>{ $when }</b> у { $teacher } в расписании. Учитель получил уведомление.
book-done-request = Заявка отправлена: учитель подтвердит или отклонит <b>{ $when }</b>. До ответа время не занято.
book-slot-taken = Этот слот уже занят. Вот обновлённый список:
book-weekly-limit = На этой неделе у вас уже { $limit } { $limit ->
        [one] занятие
        [few] занятия
       *[other] занятий
    } у этого учителя, запись невозможна.
book-requests-full = На это время уже есть заявки, выберите другое.
book-pending-exists = Вы уже отправили заявку на это время.
booking-settings = <b>Запись учеников</b>
    Режим календаря: { $mode }
    Подтверждение заявок: { $confirmation ->
        [manual] вручную
       *[auto] без подтверждения
    }
    Минимальный срок до начала: { $notice } ч
    Горизонт: { $horizon } дн.
    Длительности: { $durations }
    Шаг сетки: { $step } мин
    Заявок на один слот (режим с подтверждением): { $pending }
btn-set-booking = 📝 Запись
btn-booking-confirmation-auto = Подтверждение: нет
btn-booking-confirmation-manual = Подтверждение: вручную
btn-booking-notice = Мин. срок
btn-booking-horizon = Горизонт
btn-booking-durations = Длительности
btn-booking-step = Шаг: { $step } мин
btn-booking-pending = Заявок на слот
setting-edit-bookingMinNoticeHours = Минимальный срок до начала занятия, часов (0–336):
setting-edit-bookingHorizonDays = На сколько дней вперёд открыта запись (1–90):
setting-edit-bookingDurations = Допустимые длительности через запятую, например <code>45, 60, 90</code> (до 6 значений; пусто = длительность по умолчанию):
setting-edit-bookingMaxPending = Сколько заявок принимать на одно время в режиме с подтверждением (1–10):
booking-durations-default = по умолчанию ({ $duration } мин)

## Notifications: copies, reminders, quiet hours, digest, settings (M4-05, 5.13)
ntf-header-cc = 📨 <i>Копия сообщения для { $name }</i>
ntf-header-via-parent = 📨 <i>Сообщение для { $name } (бот ученика недоступен)</i>
ntf-digest-daily = ☀️ <b>Сводка на { $date }</b>
    Занятий сегодня: { $count }{ $count ->
        [0] {""}
       *[other] {" "}— { $lessons }
    }
    Без итогов: { $awaiting } · Заявок ждут ответа: { $requests } · На проверке: { $unchecked }
ntf-channel-unreachable = ⚠️ { $student } заблокировал(а) бота — уведомления не доставляются. Копии родителям продолжают приходить.
btn-set-notifications = 🔔 Уведомления
notif-settings-teacher = <b>Уведомления</b>
    Напоминания о занятиях: { $reminders }
    Тихие часы: { $quiet }
    Утренняя сводка: { $digest }
    Копии родителям по умолчанию: { $cc }
    Доставка через родителя, если ученик заблокировал бота: { $viaParent ->
        [on] включена
       *[off] выключена
    }
notif-settings-student = <b>Уведомления</b>
    Напоминания о занятиях: { $reminders }
    Тихие часы: { $quiet }
    Отключённые сообщения: { $muted }
notif-settings-parent = <b>Уведомления</b>
    Тихие часы: { $quiet }
    Отключённые копии (некритичные): { $muted }
notif-reminders-off = выключены
notif-quiet-off = выключены
notif-quiet-range = { $from }–{ $to }
notif-digest-off = выключена
notif-digest-at = в { $time }
notif-none = нет
btn-notif-reminders = ⏰ Напоминания
btn-notif-quiet = 🌙 Тихие часы
btn-notif-digest = ☀️ Сводка
btn-notif-cc = 📨 Копии родителям
btn-notif-mutes = 🔕 Отключить сообщения
btn-notif-via-parent-on = ☑️ Через родителя
btn-notif-via-parent-off = ⬜ Через родителя
btn-notif-digest-on = ☑️ Сводка включена
btn-notif-digest-off = ⬜ Сводка выключена
btn-notif-digest-time = Время сводки
btn-notif-quiet-on = ☑️ Тихие часы
btn-notif-quiet-off = ⬜ Тихие часы
btn-notif-quiet-edit = Изменить интервал
notif-reminders-prompt = <b>Напоминания о занятиях</b>
    Отметьте до трёх интервалов:
notif-reminder-offset = { $minutes ->
    [15] за 15 мин
    [30] за 30 мин
    [60] за 1 ч
    [120] за 2 ч
    [180] за 3 ч
   *[1440] за 24 ч
}
notif-reminders-too-many = Не больше трёх интервалов.
notif-quiet-prompt = Введите тихие часы в формате <code>22:00-08:00</code>:
notif-quiet-invalid = Не понял. Формат: <code>22:00-08:00</code>.
notif-digest-time-prompt = Во сколько присылать сводку (например, <code>08:00</code>)?
notif-time-invalid = Не понял время. Формат: <code>08:00</code>.
notif-cc-prompt = <b>Копии родителям по умолчанию</b>
    Отмеченные типы сообщений ученика уходят родителям копией. Для отдельного ученика копии настраиваются в его карточке.
notif-mutes-prompt = <b>Отключить сообщения</b>
    Отмеченные сообщения вы будете получать; снимите отметку, чтобы отключить. Критичные сообщения отключить нельзя.
notif-cc-student = <b>Копии родителям: { $student }</b>
    По умолчанию: { $default }. Переопределение для ученика — отметками ниже; «Сбросить» возвращает значения по умолчанию.
btn-notif-reset = ↩️ Сбросить к умолчаниям
btn-cc-student = 📨 Копии родителям
notif-type-name = { $code ->
    [lesson-reminder] Напоминание о занятии
    [lesson-created] Назначено занятие
    [lesson-rescheduled] Перенос занятия
    [lesson-cancelled] Отмена занятия
    [cancellation-bulk] Массовая отмена
    [lesson-summary] Итоги занятия
    [booking-decided] Решение по заявке
    [link-ended] Завершение занятий
    [digest-daily] Утренняя сводка
    [series-created] Регулярные занятия
    [material-granted] Выдан материал
    [homework-assigned] Новое задание
    [homework-due-soon] Скоро срок задания
    [homework-overdue] Просрочка задания
    [submission-received] Сдана работа
    [submission-reviewed] Проверка задания
    [storage-full] Хранилище заполнено
    [file-infected] Файл отклонён антивирусом
   *[other] { $code }
}

## System cancellation reasons stored as codes (M-3) and starter reason templates (5.7.2)
ntf-system-cancel = { $code ->
    [link-ended] Занятия с учителем завершены
    [account-blocked] Доступ к платформе приостановлен
    [series-paused] Регулярные занятия поставлены на паузу
    [series-ended] Регулярные занятия завершены
    [series-changed] Регулярные занятия изменены
   *[other] { $code }
}
cancel-template-teacher-1 = Заболел(а), занятие отменяется
cancel-template-teacher-2 = Непредвиденные обстоятельства
cancel-template-teacher-3 = Технические проблемы со связью
cancel-template-person-1 = Заболел(а)
cancel-template-person-2 = Контрольная или мероприятие в школе
cancel-template-person-3 = Семейные обстоятельства

## Materials, collections, grants (M5-02, UC-25, 5.9)
ntf-material-granted = 📚 { $kind ->
    [collection] Вам открыта подборка <b>{ $title }</b>
   *[material] Вам выдан материал <b>{ $title }</b>
  } (учитель { $teacher }).
btn-open-material = 📂 Открыть
materials-list = <b>Материалы</b> · в библиотеке: { $total }
materials-empty = <b>Материалы</b>
    Библиотека пуста. Отправьте боту файл или добавьте ссылку или текст — потом выдайте ученикам или группам.
btn-upload-material = 📎 Загрузить файл
btn-add-link = 🔗 Ссылка
btn-add-text = 📝 Текст
btn-collections = 📚 Подборки ({ $count })
material-kind-file = 📄 Файл: { $name } ({ $size })
material-kind-link = 🔗 { $url }
material-kind-text = 📝 Текст
material-card = <b>{ $title }</b>
    { $kind }{ $description }
    Выдач: { $grants } · Просмотрели: { $views }{ $collections }
material-in-collections = {" "}· В подборках: { $names }
btn-grant = 👤 Выдать
btn-material-grants = 🧾 Выдачи ({ $count })
btn-to-collection = ➕ В подборку
btn-archive-material = 🗄 В архив
btn-get-file = 📥 Получить файл
material-archived = Материал убран в архив; у учеников он больше не виден.
grants-list = <b>Выдачи: { $title }</b>
    Нажмите на выдачу, чтобы отозвать её (ученик ничего не получит, материал просто исчезнет).
grants-empty = <b>Выдачи: { $title }</b>
    Пока никому не выдано.
grant-line = { $who }{ $from }
grant-from = {" "}· с { $date }
grant-revoked = Выдача отозвана.
upload-ask-file = <b>Загрузка материала.</b> Отправьте файл (документ, фото, аудио или видео до 20 МБ). Файлы PDF и документы лучше отправлять «как файл».
upload-kind-refused = Такое сообщение сохранить нельзя. Отправьте файл, фото, аудио или видео.
upload-one-at-a-time = Сейчас я жду название. Следующий файл отправьте после того, как сохраним этот.
upload-photo-hint = 💡 Telegram сжимает фото. Для разборчивых сканов отправляйте «как файл».
upload-type-refused = Формат .{ $ext } не принимается. Можно: { $allowed }.
upload-too-large = Файл больше { $max } МБ. Сожмите его или разделите.
upload-ask-title = Файл <b>{ $name }</b> сохранён. Как назвать материал? Напишите или оставьте имя файла.
btn-keep-file-name = Оставить имя файла
upload-done = ✅ Материал «{ $title }» добавлен в библиотеку.
addlink-ask-url = <b>Новая ссылка.</b> Отправьте адрес (https://…).
addlink-bad-url = Это не похоже на ссылку. Нужен адрес вида https://…
addtext-ask-body = <b>Новый текст.</b> Отправьте текст материала (конспект, заметку).
add-ask-title = Название материала?
grant-pick = <b>Кому выдать «{ $title }»?</b> Выберите группу или ученика.
btn-grant-later = Позже
grant-later-ok = Хорошо, материал в библиотеке — выдать можно из его карточки.
grant-when = Выдаём: <b>{ $who }</b>. Открыть сейчас или с даты? Напишите дату (дд.мм.гггг) или нажмите «Сейчас».
btn-grant-now = Сейчас
grant-bad-date = Не понял дату. Формат: дд.мм.гггг, например 01.11.2026.
grant-done = ✅ Выдано: <b>{ $who }</b>{ $from }. Получателей: { $count }.
grant-opens = {" "}(откроется { $date })
collections-list = <b>Подборки</b>
collections-empty = <b>Подборки</b>
    Подборок пока нет. Подборка — упорядоченный набор материалов на тему, месяц или курс.
btn-new-collection = ➕ Новая подборка
collection-card = <b>{ $title }</b>{ $period }
    Материалов: { $count }
    { $items }
collection-period = {" "}· { $from } — { $to }
btn-collection-add = ➕ Добавить материал
pick-material = Выберите материал для подборки «{ $title }».
collection-item-added = Материал добавлен в подборку.
newcol-ask-title = <b>Новая подборка.</b> Название?
newcol-ask-period = Период подборки (дд.мм.гггг – дд.мм.гггг) или «Пропустить».
newcol-bad-period = Не понял период. Пример: 01.11.2026 – 30.11.2026.
newcol-done = ✅ Подборка «{ $title }» создана.
btn-open = Открыть
lesson-materials = <b>Материалы занятия</b> { $when }
    { $items }
lesson-materials-empty = <b>Материалы занятия</b> { $when }
    Пока ничего не прикреплено. Материал можно выдать участникам до занятия или после итогов.
btn-attach-before = ➕ Выдать до занятия
btn-attach-after = ➕ Выдать после занятия
btn-lesson-materials = 📎 Материалы
lesson-material-line = { $release ->
    [before] ⏮
   *[after] ⏭
  } { $title }
lesson-material-attached = Материал прикреплён к занятию.
pick-material-lesson = Какой материал выдать { $release ->
    [before] до занятия
   *[after] после занятия
  }?
smat-teachers = <b>Материалы</b>
    Выберите учителя.
smat-empty = <b>Материалы</b>
    Пока ничего не выдано. Материалы появятся здесь, когда учитель их откроет.
smat-library = <b>Материалы · { $teacher }</b>
smat-library-empty = <b>Материалы · { $teacher }</b>
    Пока ничего не выдано.
smat-collection = <b>📚 { $title }</b>{ $period } · материалов: { $count }
smat-material = { $icon } <b>{ $title }</b>{ $description }{ $body }
smat-no-access = Материал недоступен.
smat-file-pending = Файл ещё проверяется, попробуйте чуть позже.
btn-open-link = 🔗 Открыть ссылку

## Homework: notifications (M5-03, M5-04, 5.10.5, 5.13.1)
ntf-homework-assigned = 📝 Новое задание: <b>{ $title }</b> (учитель { $teacher }). Срок: { $due }.
ntf-homework-due-soon = ⏰ Через { $hours } ч срок задания <b>{ $title }</b> ({ $due }).
ntf-homework-overdue = ⚠️ Срок задания <b>{ $title }</b> прошёл ({ $due }). Сдайте работу или напишите учителю.
ntf-submission-received = 📥 { $student } сдал(а) задание <b>{ $title }</b>{ $late ->
    [yes] {" "}(после срока)
   *[no] {""}
  }{ $attempt ->
    [1] {""}
   *[other] {" "}· попытка { $attempt }
  }.
ntf-submission-reviewed = { $decision ->
    [accepted] ✅ Задание <b>{ $title }</b> принято
   *[returned] 🔁 Задание <b>{ $title }</b> возвращено на доработку
  }{ $comment ->
    [yes] {" "}— есть комментарий учителя
   *[no] {""}
  }{ $files ->
    [0] {""}
   *[other] {" "}· прикреплён проверенный файл
  }. Откройте задание, чтобы посмотреть.
btn-open-assignment = 📝 Открыть задание
btn-open-submission = 📂 Открыть
hw-no-due = без срока

## Homework screens (M5-03, M5-04, UC-26…28)
ntf-file-infected = 🛡 Файл <b>{ $name }</b> не прошёл антивирусную проверку и удалён. Если это сдача — отправьте работу заново.
file-infected-note = Часть файлов не прошла антивирусную проверку и недоступна.
btn-delete-material = 🗑 Удалить
material-delete-confirm = Удалить материал «{ $title }» навсегда? Файл будет стёрт из хранилища, ученики его не увидят.
btn-delete-confirm = Да, удалить
material-deleted = Материал удалён, место в хранилище освобождено.
btn-purge-files = 🗑 Удалить файлы
submission-files-purged = Файлы сдачи удалены ({ $count }), место освобождено.
ntf-storage-full = ⚠️ Хранилище заполнено: ученики не могут сдавать работы с файлами. Удалите ненужные материалы или попросите администратора увеличить квоту.
assignments-list = <b>Задания</b> · активных: { $active }
assignments-empty = <b>Задания</b>
    Заданий пока нет. Создайте первое: условие, кому и срок — ученики получат уведомление.
btn-new-assignment = ➕ Новое задание
btn-review-queue = 📥 На проверке ({ $count })
btn-closed-assignments = 🗂 Закрытые ({ $count })
assignment-card = <b>{ $title }</b>{ $body }
    Срок: { $due } · Сдача: { $mode } · Статус: { $status }
    { $targets }
assignment-status = { $status ->
    [draft] черновик
    [published] опубликовано
   *[closed] закрыто
  }
assignment-due = { $mode ->
    [fixed] { $due }
    [next_lesson] к следующему занятию
   *[none] без срока
  }
submission-mode = { $mode ->
    [files] файлы
    [text] текст
    [files_text] файлы и/или текст
    [mark] отметка о выполнении
   *[none] без сдачи
  }
target-line = { $status ->
    [assigned] ⏳
    [submitted] 📥
    [overdue] ⚠️
    [returned] 🔁
    [accepted] ✅
   *[withdrawn] ➖
  } { $name }{ $due }
btn-close-assignment = 🔒 Закрыть задание
btn-publish-assignment = 📣 Опубликовать
assignment-closed = Задание закрыто: несданные работы сняты.
assignment-published = Задание опубликовано, ученики получат уведомление.
queue-list = <b>На проверке</b> · старые сверху
queue-empty = <b>На проверке</b>
    Всё проверено.
submission-card = <b>{ $student }</b> · { $title }
    Сдано { $when }{ $late ->
    [yes] {" "}(после срока)
   *[no] {""}
  } · попытка { $attempt }{ $text }{ $review }
submission-text = 💬 { $text }
submission-review-line = { $decision ->
    [accepted] ✅ Принято
   *[returned] 🔁 На доработку
  } { $when }{ $comment }
btn-accept = ✅ Принять
btn-return = 🔁 На доработку
btn-grade = ⭐ Оценить
btn-send-files = 📎 Файлы ({ $count })
grade-soon = Оценки в журнал появятся вместе с журналами (следующая веха).
review-comment-optional = <b>Принять работу.</b> Напишите комментарий ученику или пропустите.
review-comment-required = <b>На доработку.</b> Напишите, что нужно исправить (обязательно).
review-files = Прикрепить проверенный файл? Отправьте файлы (прикреплено: { $count }) или нажмите «Готово».
review-accepted = ✅ Работа принята, ученик получит сообщение.
review-returned = 🔁 Работа возвращена на доработку, ученик получит комментарий.
newhw-ask-title = <b>Новое задание.</b> Название?
newhw-ask-body = Условие задания (текст) или «Пропустить».
newhw-ask-who = <b>Кому?</b> Отметьте учеников и группы, затем «Далее».
newhw-ask-due = <b>Срок.</b> «К следующему занятию», «Без срока» или напишите дату и время: дд.мм.гггг чч:мм.
btn-due-next-lesson = 📅 К следующему занятию
btn-due-none = ♾ Без срока
newhw-bad-due = Не понял срок. Пример: 05.11.2026 18:00 (в вашем часовом поясе), и это должно быть в будущем.
newhw-ask-mode = <b>Как сдавать?</b>
btn-mode-files-text = 📎 Файлы и/или текст
btn-mode-text = 💬 Только текст
btn-mode-files = 📎 Только файлы
btn-mode-mark = ☑️ Отметка «Выполнено»
btn-mode-none = 🚫 Без сдачи
newhw-confirm = <b>{ $title }</b>
    Кому: { $who }
    Срок: { $due } · Сдача: { $mode }
    После срока: { $late ->
        [yes] принимается
       *[no] не принимается
      } · Пересдача: { $resubmit ->
        [yes] разрешена
       *[no] запрещена
      }
btn-toggle-late = После срока: { $value ->
    [yes] да
   *[no] нет
  }
btn-toggle-resubmit = Пересдача: { $value ->
    [yes] да
   *[no] нет
  }
newhw-done = ✅ Задание «{ $title }» опубликовано: адресатов { $count }.
newhw-no-one = Выберите хотя бы одного ученика или группу.
btn-assign-homework = 📝 Задать ДЗ
shw-list = <b>Задания</b> · активных: { $active }
    { $items }
shw-empty = <b>Задания</b>
    Активных заданий нет.
shw-line = { $status ->
    [overdue] ⚠️
    [returned] 🔁
    [submitted] 📥
    [accepted] ✅
   *[assigned] ⏳
  } { $title } · { $due }
btn-finished-assignments = 🗂 Завершённые
shw-card = <b>{ $title }</b> (учитель { $teacher }){ $body }
    Срок: { $due } · Статус: { $status }{ $history }
shw-status = { $status ->
    [assigned] не сдано
    [submitted] на проверке
    [overdue] срок прошёл
    [returned] на доработку
    [accepted] принято
   *[withdrawn] снято
  }
shw-attempt = · Попытка { $attempt } ({ $when }){ $review }
shw-review = {" "}— { $decision ->
    [accepted] ✅ принято
   *[returned] 🔁 на доработку
  }{ $comment }
btn-submit = 📤 Сдать
btn-mark-done = ☑️ Выполнено
btn-review-files = 📎 Файлы учителя ({ $count })
shw-marked-done = ☑️ Отмечено как выполненное.
submit-collect = <b>Сдача: { $title }.</b> Отправляйте файлы, фото или текст — можно несколькими сообщениями. Когда всё, нажмите «Готово».
submit-collect-files = <b>Сдача: { $title }.</b> Отправляйте файлы или фото (можно несколько). Когда всё, нажмите «Готово».
submit-collect-text = <b>Сдача: { $title }.</b> Напишите ответ текстом (можно в несколько сообщений). Когда всё, нажмите «Готово».
submit-summary = Собрано: файлов { $files }, текстов { $texts }.
submit-text-not-accepted = В этом задании принимаются только файлы.
submit-files-not-accepted = В этом задании принимается только текст.
submit-too-many-files = Не больше { $max } файлов в одной сдаче.
submit-voice-later = Голосовые сообщения пока не принимаются — отправьте файл или текст.
submit-preview = <b>Проверьте сдачу: { $title }.</b>
    { $summary } { $names }
btn-send-submission = 📤 Отправить
btn-add-more = ➕ Добавить ещё
submit-sent = ✅ Работа отправлена учителю: { $title }.
submit-refused-late-forbidden = Срок сдачи прошёл, напишите учителю.
submit-refused-resubmit-forbidden = Пересдача по этому заданию не разрешена.
submit-refused-closed = Задание уже закрыто.
submit-refused-no-submission = По этому заданию сдача не требуется.
submit-refused-files-expired = Черновик устарел (файлы хранятся 24 часа). Соберите работу заново.
submit-refused-status-submitted = Работа уже на проверке.
submit-refused-status-accepted = Работа уже принята.
submit-refused-status-withdrawn = Задание снято.
submit-refused-too-many-files = Слишком много файлов для этого задания.
submit-refused-files-required = Нужен хотя бы один файл.
submit-refused-text-required = Нужен текстовый ответ.
submit-refused-text-only = В этом задании принимается только текст.
submit-refused-empty = Отправьте файл или текст.
submit-refused-conflict = Сдать не получилось. Откройте задание и попробуйте снова.
phw-list = <b>Задания { $child }</b>
    { $items }
phw-empty = <b>Задания { $child }</b>
    Активных заданий нет.
