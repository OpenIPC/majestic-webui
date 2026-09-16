#!/usr/bin/haserl
<%in p/common.cgi %>
<%
config_file=/etc/webui/max.conf
params="enabled token chat_id interval caption crontab clips video video_seconds proxy"

# Webhook for a remote send, answering true or false.
#
# sbin/max reports the send through its exit status, so the answer needs no
# JSON parsed on the camera -- which matters here more than it does next door,
# because MAX answers in JSON at every step of a send.
#
# Two verbs, each asking for exactly what it is named: ?send=image goes on
# meaning a picture on a camera whose schedule has been switched over to video,
# which is what a dashboard fetching a thumbnail every minute wants. The switch
# on this page governs the SCHEDULE, where nobody is present to say; the Try it
# button asks for whichever the page is set to send.
#
# The page's own button POSTs. A GET is what a browser issues on its own -- a
# prefetch, a restored tab, a link from anywhere -- and it carries the session
# with it, so a control this repo draws must not actuate a camera through one;
# the PTZ pad follows the same rule. Both verbs still answer a GET because they
# are published on this page for something outside the camera to call, and
# turning them into POST would break every doorbell wired to them.
send_verb=$GET_send
[ -z "$send_verb" ] && send_verb=$POST_send
if [ "$send_verb" = "image" ] || [ "$send_verb" = "clip" ]; then
	echo "Content-type: text/html; charset=UTF-8"
	echo
	send_what=--image
	[ "$send_verb" = "clip" ] && send_what=--clip
	if max "$send_what" >/dev/null 2>&1; then echo true; else echo false; fi
	exit 0
fi

if [ "$REQUEST_METHOD" = "POST" ]; then
	for p in $params; do
		eval max_${p}=\$POST_max_${p}
	done

	if [ "$max_enabled" = "true" ]; then
		[ -z "$max_token" ] && set_error_flag "Укажите токен бота, прежде чем включать MAX."
		[ -z "$max_chat_id" ] && set_error_flag "Укажите чат, прежде чем включать MAX."
	fi

	if [ -z "$error" ]; then
		rm -f "$config_file"
		for p in $params; do
			echo "max_${p}=\"$(eval echo \$max_${p})\"" >> "$config_file"
		done

		# The interval is a WORD in the cron line, not a number dropped into
		# the minute field: `*/60` matches only minute 0, so writing the
		# figure straight in would make every interval above an hour mean the
		# same thing. Built from the word the page offered instead.
		# Anchored on the program, not on the word: a bare /max/ would also
		# match a line running anything else whose path happens to contain
		# those three letters.
		sed -i '\#/usr/sbin/max$#d' /etc/crontabs/root
		if [ "$max_enabled" = "true" ] && [ "$max_crontab" = "true" ]; then
			case "$max_interval" in
			15 | 30) cron_when="*/${max_interval} * * * *" ;;
			60) cron_when="0 * * * *" ;;
			360) cron_when="0 */6 * * *" ;;
			*) cron_when="*/15 * * * *" ;;
			esac
			echo "${cron_when} /usr/sbin/max" >> /etc/crontabs/root
		fi

		if notify_hooks_sync; then
			redirect_back "success" "Настройки MAX сохранены."
		fi

		redirect_back "warning" "Настройки MAX сохранены. $notify_hooks_msg"
	fi

	redirect_to "$SCRIPT_NAME"
fi

[ -e "$config_file" ] && include $config_file
[ -z "$max_crontab" ] && max_crontab="true"

# The interval is written into a <script type="application/json"> block, so it
# is narrowed to the four values this page offers rather than rendered as
# whatever the file happens to hold. A hand-edited value carrying </script>
# would otherwise end the JSON block early and put the rest of itself on the
# page as markup. The same reason the seconds below are clamped: what the page
# shows has to be one of the things the page can mean.
case "$max_interval" in
15 | 30 | 60 | 360) ;;
*) max_interval="15" ;;
esac

# The sender's own default and the sender's own clamp, both said here too.
# The page reads whatever is in the file, which nothing obliges to be one of
# the lengths offered: a hand-edited 600 would select none of them, so the
# list would show 5, the webhook card would promise 600, and the send would
# ask the camera for the 60 it clamps to -- three numbers for one setting.
# These are the SENDER's bounds rather than the offered list's, because what
# the card promises has to be what the send does; a hand-edited length the
# list does not offer is still honoured, it just cannot be shown as picked.
case "$max_video_seconds" in
"" | *[!0-9]* | ????*) max_video_seconds="10" ;;
esac
[ "$max_video_seconds" -lt 1 ] && max_video_seconds="10"
[ "$max_video_seconds" -gt 60 ] && max_video_seconds="60"

# What the status line says before any script runs. A page that renders its
# verdict only from JS says nothing at all on a camera whose browser refused
# the file, and this is the one line on the page that has to be there.
mx_sender=false
[ -x /usr/sbin/max ] && mx_sender=true
mx_addressed=false
[ -n "$max_token" ] && [ -n "$max_chat_id" ] && mx_addressed=true

if [ "$mx_sender" != "true" ]; then
	mx_head="Эта прошивка не умеет отправлять в MAX"
	mx_level=" mj-status-bad"
	mx_what="&mdash;"
	mx_when="часть, которая отправляет, не установлена"
elif [ "$max_enabled" != "true" ]; then
	mx_head="Выключено"
	mx_level=" mj-status-off"
	mx_what="&mdash;"
	mx_when="ничего отправляться не будет"
elif [ "$mx_addressed" != "true" ]; then
	mx_head="Ещё не настроено"
	mx_level=" mj-status-off"
	mx_what="&mdash;"
	mx_when="нужны бот и чат"
else
	mx_head="Готово"
	mx_level=""
	mx_what="$([ "$max_video" = "true" ] && echo "видео ${max_video_seconds} с" || echo "Снимок")"
	mx_when="выясняем, что умеет камера&hellip;"
fi

# What the form holds as saved, as JSON literals, so the page can tell a
# preview of unsaved edits from what the camera is actually set to do.
mx_on=false;    [ "$max_enabled" = "true" ] && mx_on=true
mx_vid=false;   [ "$max_video" = "true" ] && mx_vid=true
mx_clips=false; [ "$max_clips" = "true" ] && mx_clips=true
mx_cron=false;  [ "$max_crontab" = "true" ] && mx_cron=true

mx_who="адрес не указан"
[ "$mx_addressed" = "true" ] && mx_who="в чат $(esc "$max_chat_id")"
%>

<%in p/header.cgi %>

<script type="application/json" id="mj-notify-boot">{"key":"max","label":"MAX","sender":<%= $mx_sender %>,"addressed":<%= $mx_addressed %>,"missing":"нужны бот и чат","words":{"cannotSend":"\u042d\u0442\u0430 \u043f\u0440\u043e\u0448\u0438\u0432\u043a\u0430 \u043d\u0435 \u0443\u043c\u0435\u0435\u0442 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u044f\u0442\u044c \u0432 ","noSender":"\u0447\u0430\u0441\u0442\u044c, \u043a\u043e\u0442\u043e\u0440\u0430\u044f \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u044f\u0435\u0442, \u043d\u0435 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u0430","off":"\u0412\u044b\u043a\u043b\u044e\u0447\u0435\u043d\u043e","nothingSent":"\u043d\u0438\u0447\u0435\u0433\u043e \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u044f\u0442\u044c\u0441\u044f \u043d\u0435 \u0431\u0443\u0434\u0435\u0442","notSetUp":"\u0415\u0449\u0451 \u043d\u0435 \u043d\u0430\u0441\u0442\u0440\u043e\u0435\u043d\u043e","ready":"\u0413\u043e\u0442\u043e\u0432\u043e","partly":"\u041d\u0435 \u0432\u0441\u0451 \u0431\u0443\u0434\u0435\u0442 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u044f\u0442\u044c\u0441\u044f","checking":"\u0432\u044b\u044f\u0441\u043d\u044f\u0435\u043c, \u0447\u0442\u043e \u0443\u043c\u0435\u0435\u0442 \u043a\u0430\u043c\u0435\u0440\u0430\u2026","onMovement":"\u043a\u043e\u0433\u0434\u0430 \u0447\u0442\u043e-\u0442\u043e \u0434\u0432\u0438\u0436\u0435\u0442\u0441\u044f","onRequest":"\u043a\u043e\u0433\u0434\u0430 \u043a\u0442\u043e-\u0442\u043e \u0437\u0430\u043f\u0440\u043e\u0441\u0438\u0442","everyHour":"\u043a\u0430\u0436\u0434\u044b\u0439 \u0447\u0430\u0441","everySixHours":"\u043a\u0430\u0436\u0434\u044b\u0435 \u0448\u0435\u0441\u0442\u044c \u0447\u0430\u0441\u043e\u0432","onTimer":"\u043f\u043e \u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u044e","everyN":"\u043a\u0430\u0436\u0434\u044b\u0435 {n} \u043c\u0438\u043d","picture":"\u0421\u043d\u0438\u043c\u043e\u043a","videoN":"\u0432\u0438\u0434\u0435\u043e {n} \u0441","none":"\u2014","and":" \u0438 ","comma":", ","detectorOff":"\u041a\u0430\u043c\u0435\u0440\u0430 \u043d\u0435 \u0441\u043b\u0435\u0434\u0438\u0442 \u0437\u0430 \u0434\u0432\u0438\u0436\u0435\u043d\u0438\u0435\u043c, \u043f\u043e\u044d\u0442\u043e\u043c\u0443 \u044d\u0442\u043e \u043d\u0435 \u0441\u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442. \u0412\u0441\u0451 \u043e\u0441\u0442\u0430\u043b\u044c\u043d\u043e\u0435 \u043d\u0430 \u044d\u0442\u043e\u0439 \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u0435 \u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442 \u0438 \u0431\u0435\u0437 \u043d\u0435\u0433\u043e.","detectorUnknown":"\u041a\u0430\u043c\u0435\u0440\u0430 \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b\u0430 \u043d\u0430 \u0432\u043e\u043f\u0440\u043e\u0441, \u0441\u043b\u0435\u0434\u0438\u0442 \u043b\u0438 \u043e\u043d\u0430 \u0437\u0430 \u0434\u0432\u0438\u0436\u0435\u043d\u0438\u0435\u043c, \u043f\u043e\u044d\u0442\u043e\u043c\u0443 \u044d\u0442\u043e \u043c\u043e\u0436\u0435\u0442 \u043d\u0435 \u0441\u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c.","switchItOn":"\u0412\u043a\u043b\u044e\u0447\u0438\u0442\u044c","unsaved":"\u0422\u0430\u043a \u0431\u0443\u0434\u0435\u0442 \u043f\u043e\u0441\u043b\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u044f. \u041f\u043e\u043a\u0430 \u043a\u0430\u043c\u0435\u0440\u0430 \u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442 \u0441 \u0442\u0435\u043c\u0438 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0430\u043c\u0438, \u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u0431\u044b\u043b\u0438 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u044b \u0432 \u043f\u0440\u043e\u0448\u043b\u044b\u0439 \u0440\u0430\u0437.","recording":"\u0417\u0430\u043f\u0438\u0441\u044b\u0432\u0430\u0435\u043c \u0438 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u044f\u0435\u043c. \u042d\u0442\u043e \u0437\u0430\u0439\u043c\u0451\u0442 \u043d\u0435\u0441\u043a\u043e\u043b\u044c\u043a\u043e \u0441\u0435\u043a\u0443\u043d\u0434.","sending":"\u041e\u0442\u043f\u0440\u0430\u0432\u043b\u044f\u0435\u043c\u2026","sent":"\u041e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e. \u0417\u0430\u0433\u043b\u044f\u043d\u0438\u0442\u0435 \u0432 {service}.","sendFailed":"\u041a\u0430\u043c\u0435\u0440\u0430 \u043d\u0435 \u0441\u043c\u043e\u0433\u043b\u0430 \u043e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c. \u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438 \u043d\u0438\u0436\u0435; \u043f\u0440\u0438\u0447\u0438\u043d\u0430 \u0435\u0441\u0442\u044c \u0432 \u0436\u0443\u0440\u043d\u0430\u043b\u0435 \u043a\u0430\u043c\u0435\u0440\u044b.","tooSlow":"\u041a\u0430\u043c\u0435\u0440\u0430 \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b\u0430 \u0437\u0430 \u0434\u0432\u0435 \u043c\u0438\u043d\u0443\u0442\u044b. \u0412\u043e\u0437\u043c\u043e\u0436\u043d\u043e, \u043e\u043d\u0430 \u0435\u0449\u0451 \u043f\u044b\u0442\u0430\u0435\u0442\u0441\u044f.","unreachable":"\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u0432\u044f\u0437\u0430\u0442\u044c\u0441\u044f \u0441 \u043a\u0430\u043c\u0435\u0440\u043e\u0439.","partlyWhy":"\u043a\u0430\u043c\u0435\u0440\u0430 \u043d\u0435 \u0441\u043b\u0435\u0434\u0438\u0442 \u0437\u0430 \u0434\u0432\u0438\u0436\u0435\u043d\u0438\u0435\u043c","unknownWhy":"\u043a\u0430\u043c\u0435\u0440\u0430 \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b\u0430, \u0441\u043b\u0435\u0434\u0438\u0442 \u043b\u0438 \u043e\u043d\u0430 \u0437\u0430 \u0434\u0432\u0438\u0436\u0435\u043d\u0438\u0435\u043c"},"schedulable":true,"saved":{"enabled":<%= $mx_on %>,"video":<%= $mx_vid %>,"seconds":<%= $max_video_seconds %>,"clips":<%= $mx_clips %>,"crontab":<%= $mx_cron %>,"interval":<%= $max_interval %>}}</script>

<div class="mj-status<%= $mx_level %>" id="mj-notify-status">
	<span class="mj-status-ico">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.7"/><path d="M12 11.2v5.2"/><path d="M12 7.7h.01"/></svg>
	</span>
	<span class="mj-status-txt">
		<b class="mj-notify-head"><%= $mx_head %></b>
		<span class="mj-notify-who"><%= $mx_who %></span>
	</span>
	<span class="mj-status-val">
		<b class="mj-notify-what"><%= $mx_what %></b>
		<span class="mj-notify-when"><%= $mx_when %></span>
	</span>
</div>

<span class="mj-say text-secondary" id="mj-notify-unsaved" hidden></span>

<form action="<%= $SCRIPT_NAME %>" method="post">
<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card"><div class="card-body">
			<% card_head "Бот" %>
			<p class="small text-secondary">Без этих двух полей отправлять некуда. Как получить бота &mdash; справа.</p>
			<% field_password "max_token" "Токен" "Выдаётся в личном кабинете после модерации бота. Это длинная строка — вставьте её целиком." %>
			<% field_text "max_chat_id" "Чат" "Номер чата, куда отправлять; у группы он отрицательный. Сначала добавьте бота в чат &mdash; пока этого нет, он не видит ни одного чата." %>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "Что отправлять" %>

			<% field_switch "max_enabled" "Отправлять в MAX" "eval" %>

			<% group_head "Сообщение" %>
			<p class="boolean mj-row">
				<label for="max_video" class="form-label">Снимок или видео</label>
				<span class="mj-ctl"><span class="mj-ctl-in">
					<span class="mj-seg" role="group" aria-label="Снимок или видео">
						<input type="radio" class="mj-seg-in" name="max_video" id="max_video_off" value="false" <% [ "$max_video" != "true" ] && echo checked %>>
						<label class="mj-seg-lbl" for="max_video_off">Снимок</label>
						<input type="radio" class="mj-seg-in" name="max_video" id="max_video" value="true" <% [ "$max_video" = "true" ] && echo checked %>>
						<label class="mj-seg-lbl" for="max_video">Видео</label>
					</span>
				</span></span>
				<span class="hint text-secondary">Камера записывает видео прямо во время отправки, поэтому карта памяти не нужна.</span>
			</p>

			<p class="select mj-row" id="max_video_seconds_wrap">
				<label for="max_video_seconds" class="form-label">Длительность</label>
				<span class="mj-ctl"><span class="mj-ctl-in">
					<select class="form-select" id="max_video_seconds" name="max_video_seconds">
						<option value="5" <% [ "$max_video_seconds" = "5" ] && echo selected %>>5 секунд</option>
						<option value="10" <% [ "$max_video_seconds" = "10" ] && echo selected %>>10 секунд</option>
						<option value="15" <% [ "$max_video_seconds" = "15" ] && echo selected %>>15 секунд</option>
						<option value="30" <% [ "$max_video_seconds" = "30" ] && echo selected %>>30 секунд</option>
						<option value="60" <% [ "$max_video_seconds" = "60" ] && echo selected %>>Минута</option>
					</select>
				</span></span>
				<span class="hint text-secondary">Движение — исключение: с картой памяти камера отправит всю запись целиком, длиной ровно столько, сколько длилось движение.</span>
			</p>

			<% field_text "max_caption" "Подпись" "Ваш текст. <code>%hostname</code> подставит имя камеры, <code>%datetime</code> — время, <code>%soctemp</code> — температуру." %>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "Когда отправлять" %>

			<div class="mj-trig" id="mj-trig-motion">
				<span class="mj-trig-t">
					<b>Когда что-то движется</b>
					<span>С картой памяти камера отправит запись, когда движение закончится, начав её чуть раньше самого движения. Без карты — запишет несколько секунд с момента, когда движение началось.</span>
					<span class="mj-trig-why" id="mj-trig-motion-why" hidden></span>
				</span>
				<span class="form-check form-switch">
					<input type="hidden" name="max_clips" value="false">
					<input type="checkbox" class="form-check-input" id="max_clips" name="max_clips" value="true" <% [ "$max_clips" = "true" ] && echo checked %> aria-label="Когда что-то движется">
				</span>
			</div>

			<div class="mj-trig" id="mj-trig-schedule">
				<span class="mj-trig-t">
					<b>Время от времени</b>
					<span>По расписанию, независимо от того, что происходит перед камерой.</span>
					<span style="display:flex; align-items:center; gap:.6rem; margin-top:.6rem">
						<select class="form-select form-select-sm" id="max_interval" name="max_interval" style="max-width:11rem" aria-label="Как часто">
							<option value="15" <% [ "$max_interval" = "15" ] && echo selected %>>Каждые 15 минут</option>
							<option value="30" <% [ "$max_interval" = "30" ] && echo selected %>>Каждые 30 минут</option>
							<option value="60" <% [ "$max_interval" = "60" ] && echo selected %>>Каждый час</option>
							<option value="360" <% [ "$max_interval" = "360" ] && echo selected %>>Каждые шесть часов</option>
						</select>
					</span>
				</span>
				<span class="form-check form-switch">
					<input type="hidden" name="max_crontab" value="false">
					<input type="checkbox" class="form-check-input" id="max_crontab" name="max_crontab" value="true" <% [ "$max_crontab" = "true" ] && echo checked %> aria-label="Время от времени">
				</span>
			</div>

			<div class="mj-trig">
				<span class="mj-trig-t">
					<b>Когда кто-то запросит</b>
					<span>Работает всегда. Ссылки справа — для дверного звонка, датчика движения или сценария умного дома.</span>
				</span>
			</div>
		</div></div>

		<details class="mj-advanced">
			<summary>Настройки, которые вам, скорее всего, не понадобятся</summary>
			<div class="card mt-3"><div class="card-body">
				<% card_head "Соединение" %>
				<% field_switch "max_proxy" "Через прокси" "eval" "Использует <a href=\"proxy.cgi\">настройки прокси</a>. В обычной сборке поддержка прокси отключена." %>
			</div></div>
		</details>
	</div>

	<div class="col-12 col-lg-4">
		<div class="card"><div class="card-body">
			<% card_head "Как получить бота" %>
			<p class="small text-secondary"><b>Кому доступно.</b> Только организациям, ИП и <a href="https://www.nalog.gov.ru/rn53/news/activities_fts/16491143/">самозанятым</a> &mdash; физическому лицу без такого статуса бота не создать. Нужен телефон и верификация: через Госуслуги, банковский ID или вручную.</p>
			<ol class="small text-secondary mb-0 ps-3">
				<li class="mb-2">Зайдите на <a href="https://business.max.ru/self/">business.max.ru</a>, введите телефон и подтвердите профиль через Госуслуги или поддерживаемый банк. Занимает несколько минут.</li>
				<li class="mb-2">В личном кабинете откройте раздел <a href="https://business.max.ru/self/chat-bots">«Чат-боты»</a> и нажмите «Создать».</li>
				<li class="mb-2">Заполните карточку бота: название и описание. Никнейм сгенерируется сам. Дождитесь модерации &mdash; обычно до 24 часов &mdash; после неё в настройках появится токен.</li>
				<li>Добавьте бота в нужный чат и вставьте токен в поле <b>Токен</b> слева.</li>
			</ol>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "Проверка" %>
			<p class="small text-secondary">Отправит одно сообщение прямо сейчас, с настройками в том виде, в каком они были сохранены.</p>
			<button type="button" id="mj-notify-test" class="btn btn-sm btn-primary" data-send="<% [ "$max_video" = "true" ] && echo clip || echo image %>">Отправить проверочное</button>
			<span class="mj-say text-secondary" id="mj-notify-test-say"></span>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "Запросить отправку" %>
			<dl class="small list mb-0">
				<dt>Снимок</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/max.cgi?send=image</dd>
				<dt>Видео</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/max.cgi?send=clip</dd>
			</dl>
			<p class="small text-secondary mt-2">Вызов любой из ссылок отправит одно сообщение; вторая сначала запишет <% esc "$max_video_seconds" %> с. Нажмите, чтобы скопировать, затем замените <code>PASSWORD</code> на пароль от веб-интерфейса.</p>
		</div></div>
	</div>

	<div class="col-12 mj-save"><% button_submit "Сохранить" %></div>
</div>
</form>

<details class="mj-advanced">
	<summary>Файл настроек</summary>
	<div class="mt-3">
		<% [ -e "$config_file" ] && ex "sed -e 's/^max_token=.*/max_token=\"(hidden)\"/' $config_file" %>
		<% ex "grep /usr/sbin/max /etc/crontabs/root" %>
	</div>
</details>

<script src="/a/notify.js" defer></script>

<%in p/footer.cgi %>
